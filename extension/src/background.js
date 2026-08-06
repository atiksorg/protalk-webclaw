// background.js — service worker (MV3 module)
//
// Architecture v6.0 — Pure Vision-First:
//   - Thin orchestrator that imports modular components:
//     • bus.js          — shared runtime state, broadcast, utilities
//     • cdp.js          — Chrome DevTools Protocol (screenshots, trusted events)
//     • agent_tab.js    — Agent tab lifecycle, content script injection
//     • vision_loop.js  — The only execution loop (screenshot → model → tool)
//     • vision_tools.js — Coordinate-based action execution via CDP
//     • vision_prompt.js — Prompt construction for Vision-First agent
//     • task_memory.js  — Structured session memory (scratchpad)
//     • persistence.js  — State persistence to chrome.storage.session
//   - background.js owns: the main agent loop, message bus, webnavigation events,
//     CDP detach handling, and top-level orchestration.
//   - PERSISTENCE: After every step, runtime state + TaskMemory are saved to
//     chrome.storage.session. A heartbeat alarm (every ~25s) keeps the SW alive.

import { getSettings } from './settings.js';
import {
  runtime, sleep, broadcast, rehydrateRuntime,
  STEP_CAP_DEFAULT, STEP_DELAY_MS, MAX_HISTORY,
  setIconMode, setBadge
} from './bus.js';
import {
  cdpDetach, cdpAttach,
  setupNetworkIdleTracking, removeNetworkIdleTracking
} from './cdp.js';
import { ensureAgentTab } from './agent_tab.js';
import { TaskMemory, PHASES } from './task_memory.js';
import { runVisionLoop, resumeVisionLoop } from './vision_loop.js';
import { SessionLogger } from './session_logger.js';
import {
  saveState, loadState, clearState, isSessionActive,
  startHeartbeat, stopHeartbeat, handleHeartbeatAlarm,
  deserializeMemory,
  handleDeepSleepAlarm, cancelDeepSleep
} from './persistence.js';

// Module-level stop flag: set SYNCHRONOUSLY by the stop handler before any await.
// Checked by IIFE and attemptResume to prevent race conditions with SW wake.
let _stopRequested = false;

// ============================================================
// START AGENT (top-level orchestrator)
// ============================================================

async function startAgent({ task, context, initialUrl, options }) {
  if (runtime.running) return { ok: false, error: 'already_running' };
  _stopRequested = false; // Reset stop flag for fresh start
  const settings = await getSettings();
  // Validate: need model + some form of auth (except Ollama which is local)
  const provider = (settings.provider || '').toLowerCase();
  const isOllama = provider === 'ollama' ||
    (settings.model || '').toLowerCase().startsWith('ollama/') ||
    (settings.api_base_url || '').includes('localhost');
  const hasAuth = !!(settings.auth_token || settings.api_key);
  if (!settings.model || (!hasAuth && !isOllama)) {
    return { ok: false, error: 'missing_settings' };
  }

  runtime.running = true;
  runtime.paused = false;
  runtime.abortFlag = false;
  runtime.pauseFlag = false;
  runtime.step = 0;
  runtime.task = task;
  runtime.context = context || '';
  runtime.history = [];
  runtime.options = options || {};
  runtime.startedAt = Date.now();
  runtime.totalTokensUsed = 0;
  runtime._loopType = 'vision';

  // Initialize task memory
  const memory = new TaskMemory();
  memory.setUserContext(context || '');
  runtime._memory = memory;

  try {
    await ensureAgentTab(initialUrl);
  } catch (e) {
    runtime.running = false;
    await setIconMode('error');
    return { ok: false, error: 'agent_tab_failed: ' + e.message };
  }

  // Initialize session logger
  const sessionLogger = new SessionLogger();
  sessionLogger.setSessionMeta({
    task,
    context,
    model: settings.model,
    provider: settings.provider
  });
  runtime._sessionLogger = sessionLogger;

  broadcast({ kind: 'started', task, tabId: runtime.agentTabId, model: settings.model, provider: settings.provider, tokenLimit: settings.token_limit || 1000000 });
  await setIconMode('working');

  // Start heartbeat to keep SW alive during execution
  startHeartbeat(() => runtime, () => runtime._memory);

  // Persist initial state so resume can pick up even before first step
  await saveState(runtime, memory);

  // ============================================================
  // VISION-FIRST: single unified screenshot→model→tool loop
  // ============================================================
  memory.setPhase(PHASES.EXECUTING);
  broadcast({ kind: 'phase_changed', phase: PHASES.EXECUTING });
  await saveState(runtime, memory);

  const result = await runVisionLoop({ task, context, options, memory, sessionLogger });

  // Deep sleep: if the loop returned because agent is hibernating,
  // do NOT clean up — the alarm will resume us later.
  if (result.ok && result.reason === 'deep_sleep') {
    broadcast({ kind: 'log', text: '🕳️ Agent entering deep hibernation — state preserved, alarm will resume' });
    // Don't set running=false, don't clear state, don't stop heartbeat (already stopped)
    // The SW will naturally unload. attemptResume will pick up when alarm fires.
    return result;
  }

  // Finalize
  memory.setPhase(PHASES.DONE);

  // Finalize session logger: wait for screenshot uploads, then mark complete
  sessionLogger.complete();
  try {
    await sessionLogger.waitForUploads(30000);
    broadcast({ kind: 'log', text: `Session logger: ${sessionLogger.screenshotUrls.size} screenshots uploaded, ${sessionLogger.apiCalls.length} API calls logged` });
  } catch (_) {}

  runtime.running = false;
  runtime._memory = null;

  // Stop heartbeat and clear persisted state (session is over)
  stopHeartbeat();
  await clearState();

  if (result.ok) {
    await setIconMode('idle');
    broadcast({ kind: 'finished', ok: true, answer: result.answer || '', steps: runtime.step });
  } else {
    await setIconMode('error');
    broadcast({ kind: 'finished', ok: false, reason: result.reason || 'unknown', steps: runtime.step });
  }

  return result;
}

// ============================================================
// RESUME AGENT (after SW wake from persisted state)
// ============================================================

/**
 * Attempt to resume an agent session that was interrupted by SW unloading.
 * Loads persisted state, re-attaches infrastructure, and continues the loop.
 *
 * @returns {Promise<boolean>} true if resume was successful
 */
async function attemptResume() {
  // Stop guard: if user requested stop while SW was waking up, abort immediately
  if (_stopRequested) {
    broadcast({ kind: 'log', text: '[resume] Abort: stop was requested during SW wake' });
    // Clean up persisted state so we don't loop
    await clearState();
    await setIconMode('idle');
    return false;
  }

  const state = await loadState();
  if (!state) return false;

  // Rehydrate runtime from persisted state
  rehydrateRuntime(state);

  // Second stop guard: rehydrateRuntime resets abortFlag, so re-check _stopRequested
  // This handles the race where stop arrives between loadState and rehydrate
  if (_stopRequested) {
    runtime.running = false;
    runtime.abortFlag = true;
    await clearState();
    await setIconMode('idle');
    broadcast({ kind: 'log', text: '[resume] Abort: stop requested after rehydrate' });
    return false;
  }

  // Re-create TaskMemory
  const memory = deserializeMemory(state.memory, TaskMemory);
  runtime._memory = memory;

  // Re-create session logger (ephemeral — old one is lost)
  const sessionLogger = new SessionLogger();
  const settings = await getSettings();
  sessionLogger.setSessionMeta({
    task: runtime.task,
    context: runtime.context,
    model: settings.model,
    provider: settings.provider
  });
  runtime._sessionLogger = sessionLogger;

  // Re-attach agent tab (may reuse existing tab if still open)
  try {
    await ensureAgentTab();
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: '[resume] Agent tab lost, cannot continue: ' + e.message });
    runtime.running = false;
    stopHeartbeat();
    await clearState();
    await setIconMode('error');
    broadcast({ kind: 'finished', ok: false, reason: 'resume_failed: agent tab lost' });
    return false;
  }

  // Re-attach CDP
  try {
    await cdpAttach(runtime.agentTabId);
    setupNetworkIdleTracking();
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: '[resume] CDP re-attach failed (non-fatal): ' + e.message });
  }

  // Notify UI
  // If this session is in deep sleep, restore state but DON'T start the loop.
  // The loop will be started when the alarm fires or when force_wake is received.
  if (memory.phase === 'deep_sleep') {
    broadcast({ kind: 'log', text: '🕳️ Restored deep sleep session — waiting for alarm or manual wake' });
    broadcast({
      kind: 'sleep_started',
      mode: 'deep_sleep',
      reason: runtime._sleepResult?.reason || 'hibernation',
      maxDurationSec: runtime._sleepResult?.requestedDurationSec || 0,
      startedAt: runtime._sleepResult?.startedAt || Date.now(),
      wakeCondition: 'alarm_timer'
    });
    await setIconMode('sleeping');
    // Don't start heartbeat (we're hibernating)
    // Don't start the vision loop
    return true;
  }

  // Inject wake context into history if resuming from a normal interrupt
  // This helps the model understand WHY it woke up and how much time passed
  if (runtime._sleepResult) {
    const sleepResult = runtime._sleepResult;
    const elapsed = Date.now() - (sleepResult.startedAt || Date.now());
    const elapsedSec = Math.round(elapsed / 1000);
    const wakeEntry = {
      action: `[СИСТЕМА] Пробуждение из глубокой гибернации`,
      observation: `Прошло ~${elapsedSec} секунд (${Math.round(elapsedSec / 60)} мин). Причина сна: ${sleepResult.reason || '?'}. Запрошено было: ${sleepResult.requestedDurationSec || '?'}сек. Текущее состояние страницы — на скриншоте.`
    };
    runtime.history.push(wakeEntry);
    if (runtime.history.length > MAX_HISTORY) {
      runtime.history.splice(0, runtime.history.length - MAX_HISTORY);
    }
    // Clear sleep result now that we've used it
    runtime._sleepResult = null;
    runtime._currentSleep = null;
  }

  broadcast({
    kind: 'resumed_after_interrupt',
    step: runtime.step,
    phase: memory.phase,
    loopType: runtime._loopType,
    model: settings.model,
    provider: settings.provider
  });
  broadcast({ kind: 'log', text: `⚡ Resumed from step ${runtime.step} (phase: ${memory.phase})` });

  // Restart heartbeat
  startHeartbeat(() => runtime, () => runtime._memory);

  // Resume the vision loop
  let result;
  try {
    broadcast({ kind: 'log', text: '[resume] Resuming Vision-First loop' });
    result = await resumeVisionLoop({ memory, sessionLogger });
  } catch (e) {
    result = { ok: false, reason: 'resume_error: ' + e.message, steps: runtime.step };
  }

  // Deep sleep: agent hibernated again — preserve state for the new alarm
  if (result.ok && result.reason === 'deep_sleep') {
    broadcast({ kind: 'log', text: '🕳️ Agent re-entering deep hibernation — state preserved' });
    return true;
  }

  // Finalize (same as startAgent's finalization)
  memory.setPhase(PHASES.DONE);
  sessionLogger.complete();
  try {
    await sessionLogger.waitForUploads(30000);
  } catch (_) {}

  runtime.running = false;
  runtime._memory = null;
  stopHeartbeat();
  await clearState();

  if (result.ok) {
    await setIconMode('idle');
    broadcast({ kind: 'finished', ok: true, answer: result.answer || '', steps: runtime.step });
  } else {
    await setIconMode('error');
    broadcast({ kind: 'finished', ok: false, reason: result.reason || 'unknown', steps: runtime.step });
  }

  return true;
}

// ============================================================
// CLEANUP
// ============================================================

async function cleanupAgent() {
  runtime.running = false;
  try { await cdpDetach(); } catch (_) {}
  removeNetworkIdleTracking();
  stopHeartbeat();
  await clearState();
  // Keep _sessionLogger alive so user can export reports after session ends.
  // It will be replaced on next startAgent() call.
}

// ============================================================
// MESSAGE BUS
// ============================================================

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg.kind) {
        case 'start': {
          // If agent is already running, check if it's a zombie (resumed from stale state)
          if (runtime.running) {
            // If this was a resumed session without a valid agent tab, treat as zombie
            if (runtime._resumed && !runtime.agentTabId) {
              broadcast({ kind: 'log', level: 'warn', text: '[start] Zombie session detected (resumed without tab), forcing cleanup' });
              await cleanupAgent();
            } else {
              sendResponse({ ok: false, error: 'already_running', step: runtime.step, task: runtime.task });
              break;
            }
          }
          // Zombie cleanup: if a previous session was persisted but SW was unloaded,
          // clear any stale state before starting fresh
          try {
            const stale = await loadState();
            if (stale && stale.running) {
              broadcast({ kind: 'log', level: 'warn', text: '[start] Clearing stale persisted session (step ' + (stale.step || 0) + ')' });
              await clearState();
            }
          } catch (_) {}
          // Also clear any leftover runtime state from a zombie session
          if (runtime.running) {
            await cleanupAgent();
          }
          // Respond immediately so popup UI isn't blocked for the entire session.
          sendResponse({ ok: true, started: true });
          try {
            const r = await startAgent({
              task: msg.task,
              context: msg.context,
              initialUrl: msg.initialUrl,
              options: msg.options || {}
            });
            // If startAgent returned an error (e.g. missing_settings), broadcast it
            if (r && !r.ok) {
              broadcast({ kind: 'log', level: 'error', text: 'startAgent error: ' + (r.error || r.reason || 'unknown') });
              broadcast({ kind: 'finished', ok: false, reason: r.error || r.reason || 'unknown', steps: runtime.step });
            }
            // Deep sleep: state is preserved for alarm — do NOT cleanup
            if (!(r?.ok && r?.reason === 'deep_sleep')) {
              await cleanupAgent();
            }
          } catch (e) {
            broadcast({ kind: 'log', level: 'error', text: 'startAgent failed: ' + e.message });
            broadcast({ kind: 'finished', ok: false, reason: e.message, steps: runtime.step });
            await cleanupAgent();
          }
          break;
        }
        case 'stop':
          _stopRequested = true;
          runtime.abortFlag = true;
          runtime.running = false;
          runtime.pauseFlag = false;
          runtime._forceWakeFlag = false;
          runtime._deepSleepAlarmName = null;
          runtime._currentSleep = null;
          // Immediately detach CDP to prevent reattach cycle and free the tab
          try { await cdpDetach(); } catch (_) {}
          removeNetworkIdleTracking();
          await setIconMode('idle');
          stopHeartbeat();
          await cancelDeepSleep(); // Cancel any deep-sleep alarms
          await clearState();
          broadcast({ kind: 'finished', ok: false, reason: 'stopped_by_user', steps: runtime.step });
          sendResponse({ ok: true });
          break;
        case 'pause':
          runtime.pauseFlag = true;
          await setIconMode('paused');
          await saveState(runtime, runtime._memory);
          sendResponse({ ok: true });
          break;
        case 'resume':
          runtime.pauseFlag = false;
          await setIconMode('working');
          await saveState(runtime, runtime._memory);
          sendResponse({ ok: true });
          break;
        case 'get_memory':
          if (runtime._memory) {
            sendResponse({ ok: true, memory: runtime._memory.toStatusPayload() });
          } else {
            sendResponse({ ok: false, error: 'no_active_memory' });
          }
          break;
        case 'status':
          sendResponse({
            running: runtime.running,
            paused: runtime.pauseFlag,
            step: runtime.step,
            task: runtime.task,
            agentTabId: runtime.agentTabId,
            cdpAttached: runtime.cdpAttached,
            phase: runtime._memory?.phase || 'idle',
            resumed: !!runtime._resumed,
            totalTokensUsed: runtime.totalTokensUsed,
            currentSleep: runtime._currentSleep || null
          });
          break;
        case 'get_status_and_logs':
          sendResponse({
            status: {
              running: runtime.running,
              paused: runtime.pauseFlag,
              step: runtime.step,
              task: runtime.task,
              phase: runtime._memory?.phase || 'idle',
              totalTokensUsed: runtime.totalTokensUsed
            },
            logBuffer: [...(runtime._logBuffer || [])],
            currentSleep: runtime._currentSleep || null
          });
          break;
        case 'openLogs': {
          const url = chrome.runtime.getURL('src/logs.html');
          const tabs = await chrome.tabs.query({ url });
          if (tabs && tabs[0]) {
            await chrome.tabs.update(tabs[0].id, { active: true });
          } else {
            await chrome.tabs.create({ url });
          }
          sendResponse({ ok: true });
          break;
        }
        case 'openSidePanel': {
          try {
            if (sender.tab?.windowId && chrome.sidePanel?.open) {
              await chrome.sidePanel.open({ windowId: sender.tab.windowId });
              sendResponse({ ok: true });
            } else {
              const url = chrome.runtime.getURL('src/sidepanel.html');
              const existing = await chrome.tabs.query({ url });
              if (existing && existing[0]) {
                await chrome.tabs.update(existing[0].id, { active: true });
              } else {
                await chrome.tabs.create({ url });
              }
              sendResponse({ ok: true });
            }
          } catch (e) {
            try {
              const url = chrome.runtime.getURL('src/sidepanel.html');
              await chrome.tabs.create({ url });
              sendResponse({ ok: true });
            } catch (e2) {
              sendResponse({ ok: false, error: e2.message });
            }
          }
          break;
        }
        case 'toggle_overlay_widget': {
          // Toggle overlay widget on the active tab.
          // Popup cannot send messages to content scripts directly —
          // it needs the background to relay the message.
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab?.id) {
              await chrome.tabs.sendMessage(tab.id, { kind: 'toggle_widget_visibility' });
              sendResponse({ ok: true });
            } else {
              sendResponse({ ok: false, error: 'no_active_tab' });
            }
          } catch (e) {
            sendResponse({ ok: false, error: 'content_script_unavailable: ' + e.message });
          }
          break;
        }
        case 'openOptions':
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
          break;
        case 'export_html_report': {
          const logger = runtime._sessionLogger;
          if (logger) {
            try {
              logger.downloadHtmlReport();
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, error: 'no_active_session' });
          }
          break;
        }
        case 'export_api_log': {
          const logger = runtime._sessionLogger;
          if (logger) {
            try {
              logger.downloadApiLog();
              sendResponse({ ok: true });
            } catch (e) {
              sendResponse({ ok: false, error: e.message });
            }
          } else {
            sendResponse({ ok: false, error: 'no_active_session' });
          }
          break;
        }
        case 'force_wake': {
          // If runtime is not active, try to load persisted state (SW may have been unloaded)
          if (!runtime.running) {
            const persistedState = await loadState();
            if (persistedState && persistedState.memory?.phase === 'deep_sleep') {
              // Deep sleep session exists in storage — cancel alarm and resume
              broadcast({ kind: 'log', text: '⚡ Force wake: SW was unloaded, loading persisted deep-sleep session' });
              await cancelDeepSleep();
              _stopRequested = false;
              // Override phase in storage so attemptResume() won't early-return
              persistedState.memory.phase = 'executing';
              // Save the overridden state before resuming
              try { await chrome.storage.session.set({ webclaw_agent_state: persistedState }); } catch (_) {}
              sendResponse({ ok: true, mode: 'deep_sleep_resumed' });
              // attemptResume will rehydrate runtime, re-attach tab, and continue the loop
              await attemptResume();
              break;
            } else if (persistedState) {
              // Non-deep-sleep persisted session — just resume it
              broadcast({ kind: 'log', text: '⚡ Force wake: resuming persisted session' });
              _stopRequested = false;
              sendResponse({ ok: true, mode: 'resumed' });
              await attemptResume();
              break;
            }
            sendResponse({ ok: false, error: 'not_running' });
            break;
          }
          const memory = runtime._memory;
          const isWatchfulSleep = memory?.phase === PHASES.SLEEPING;
          const isDeepSleep = memory?.phase === 'deep_sleep' || runtime._deepSleepAlarmName;

          if (isWatchfulSleep) {
            // Watchful: set the force-wake flag — toolWatchfulSleep loop will break
            runtime._forceWakeFlag = true;
            broadcast({ kind: 'log', text: '⚡ Force wake requested — interrupting watchful sleep' });
            broadcast({ kind: 'force_wake', mode: 'watchful' });
            sendResponse({ ok: true, mode: 'watchful' });
          } else if (isDeepSleep) {
            // Deep sleep: cancel the alarm and resume immediately
            broadcast({ kind: 'log', text: '⚡ Force wake requested — resuming from deep hibernation' });
            await cancelDeepSleep();
            runtime._forceWakeFlag = false;
            runtime._deepSleepAlarmName = null;
            _stopRequested = false; // Allow attemptResume to proceed
            // Override phase so attemptResume() won't early-return at deep_sleep check
            if (runtime._memory) {
              runtime._memory.setPhase(PHASES.EXECUTING);
            }
            // Persist the overridden state so loadState() in attemptResume finds correct phase
            await saveState(runtime, runtime._memory);
            // Inject forced wake context into history before resuming
            if (runtime._sleepResult) {
              const elapsed = Date.now() - (runtime._sleepResult.startedAt || Date.now());
              runtime.history.push({
                action: `[СИСТЕМА] Принудительное пробуждение пользователем`,
                observation: `Прошло ~${Math.round(elapsed / 1000)} секунд (${Math.round(elapsed / 60000)} мин). Причина сна: ${runtime._sleepResult.reason || '?'}. Пользователь разбудил агента вручную.`
              });
              runtime._sleepResult = null;
              runtime._currentSleep = null;
            }
            broadcast({ kind: 'force_wake', mode: 'deep_sleep' });
            sendResponse({ ok: true, mode: 'deep_sleep' });
            // Resume the agent
            await attemptResume();
          } else {
            // Not sleeping — just abort pause if paused
            if (runtime.pauseFlag) {
              runtime.pauseFlag = false;
              broadcast({ kind: 'log', text: '⚡ Force wake: agent was paused, resumed' });
              sendResponse({ ok: true, mode: 'paused_resumed' });
            } else {
              sendResponse({ ok: false, error: 'not_sleeping' });
            }
          }
          break;
        }
        case 'ping':
          sendResponse({ ok: true });
          break;
        default:
          sendResponse({ ok: false, error: 'unknown_kind', kind: msg.kind });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ============================================================
// HEARTBEAT ALARM HANDLER
// ============================================================

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // Check if it's a heartbeat alarm
  const handled = await handleHeartbeatAlarm(
    alarm,
    () => runtime,
    () => runtime._memory
  );

  // Check if it's a deep-sleep alarm (agent was hibernating, now waking up)
  const isDeepSleep = await handleDeepSleepAlarm(alarm);

  if (isDeepSleep) {
    // Agent was in deep hibernation — wake up and resume the loop
    broadcast({ kind: 'log', text: '🕳️ Deep sleep alarm fired — resuming agent from hibernation' });
    // Clear deep sleep state so attemptResume() doesn't early-return
    // For the case where SW was unloaded and will reload state from storage,
    // override the phase in storage itself
    if (runtime._memory) {
      runtime._memory.setPhase(PHASES.EXECUTING);
    }
    runtime._sleepResult = null;
    runtime._currentSleep = null;
    runtime._deepSleepAlarmName = null;
    // Persist the phase override so attemptResume() reads 'executing' from storage
    // (covers both SW-alive and SW-unloaded scenarios)
    if (runtime.running) {
      await saveState(runtime, runtime._memory);
    } else {
      // SW was unloaded — override phase directly in storage before attemptResume loads it
      try {
        const stored = await chrome.storage.session.get('webclaw_agent_state');
        if (stored.webclaw_agent_state?.memory) {
          stored.webclaw_agent_state.memory.phase = 'executing';
          await chrome.storage.session.set(stored);
        }
      } catch (_) {}
    }
    await attemptResume();
  } else if (handled && !runtime.running) {
    // Regular heartbeat — just resume if needed
    await attemptResume();
  }
});

// ============================================================
// CDP EVENT: handle debugger disconnection
// ============================================================

chrome.debugger.onDetach.addListener((source, reason) => {
  if (source.tabId === runtime.agentTabId) {
    runtime.cdpAttached = false;
    runtime.cdpTarget = null;
    broadcast({ kind: 'log', level: 'error', text: `CDP detached: ${reason}` });

    if (!runtime.running || runtime.abortFlag) return;

    const detachReason = reason || 'unknown';

    if (detachReason === 'canceled_by_user') {
      if (!_cdpReattachCount) _cdpReattachCount = 0;
      _cdpReattachCount++;
      if (_cdpReattachCount > 2) {
        broadcast({ kind: 'log', level: 'error', text: `CDP: too many canceled_by_user detaches (${_cdpReattachCount}), stopping reattach. Close DevTools if open.` });
        return;
      }
    }

    const delay = 2000 * Math.min(_cdpReattachCount || 1, 4);
    sleep(delay).then(() => {
      if (runtime.running && !runtime.abortFlag && runtime.agentTabId) {
        cdpAttach(runtime.agentTabId).then(() => {
          if (detachReason !== 'canceled_by_user') _cdpReattachCount = 0;
        }).catch(() => {});
      }
    });
  }
});

let _cdpReattachCount = 0;

// Hotkey
chrome.commands?.onCommand.addListener((cmd) => {
  if (cmd === 'toggle') {
    if (runtime.running) {
      runtime.abortFlag = true;
      broadcast({ kind: 'finished', ok: false, reason: 'hotkey_stop', steps: runtime.step });
    } else {
      broadcast({ kind: 'log', text: 'hotkey: use the popup to start with a task' });
    }
  }
});

// ============================================================
// INIT: check for persisted session on SW startup
// ============================================================

chrome.runtime.onInstalled.addListener(async () => {
  await setIconMode('idle');
  await attemptResume();
});

chrome.runtime.onStartup?.addListener(async () => {
  await setIconMode('idle');
  await attemptResume();
});

// On module load (SW wake): check for persisted session.
(async () => {
  try {
    const active = await isSessionActive();
    if (active && !runtime.running && !_stopRequested) {
      await attemptResume();
    }
  } catch (_) {}
})();

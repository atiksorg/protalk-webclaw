// vision_loop.js — Vision-First Agent main loop.
//
// A single, unified ReAct cycle that replaces all prior loops
// (simple loop, batch loop, planner, batch executor):
//
//   screenshot → model (vision prompt) → tool execution → repeat
//
// The model sees ONLY the screenshot + task + compact action log.
// No DOM snapshots, no CSS selectors, no complex planning phases.
// The model itself decides when to extract, filter, batch, etc.
//
// Visual stagnation detection: compares sampled pixels between
// consecutive screenshots to detect when the screen hasn't changed.

import { getSettings } from './settings.js';
import { callModelWithBackoff } from './providers.js';
import { runtime, sleep, broadcast, STEP_CAP_DEFAULT, STEP_DELAY_MS, MAX_HISTORY, setIconMode, MODEL_TIMEOUT_MS } from './bus.js';
import { waitPageReady, waitPageReadyFast, captureScreenshot } from './cdp.js';
import { executeVisionTool, executeActionChain } from './vision_tools.js';
import {
  VISION_SYSTEM_PROMPT,
  buildVisionPrompt,
  parseVisionResponse,
  extractVisionThinking
} from './vision_prompt.js';
import { PHASES } from './task_memory.js';
import {
  saveState
} from './persistence.js';

// ============================================================
// SCREENSHOT HASH — simple pixel sampling for stagnation detection
// ============================================================

/**
 * Compute a quick hash from a data URL screenshot by sampling bytes.
 * Not cryptographically secure — just enough to detect "same screen".
 *
 * Samples 64 evenly-spaced characters from the middle of the base64 data
 * and concatenates them into a fingerprint string.
 *
 * @param {string} dataUrl — data:image/png;base64,...
 * @returns {string} hash fingerprint
 */
function screenshotHash(dataUrl) {
  if (!dataUrl) return '';
  // Extract base64 payload (skip "data:image/png;base64,")
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  if (b64.length < 200) return b64;

  const SAMPLES = 64;
  const step = Math.floor(b64.length / SAMPLES);
  let hash = '';
  for (let i = 0; i < SAMPLES; i++) {
    hash += b64[i * step];
  }
  return hash;
}

// ============================================================
// VISION-FIRST LOOP
// ============================================================

/**
 * The main Vision-First agent loop.
 *
 * @param {Object} params
 * @param {string} params.task — user's task description
 * @param {string} params.context — user context (resume, contacts)
 * @param {Object} params.options — stepCap, etc.
 * @param {TaskMemory} params.memory — task memory instance
 * @param {SessionLogger} params.sessionLogger — session logger
 * @returns {Promise<{ok, answer?, reason?, steps}>}
 */
export async function runVisionLoop({ task, context, options, memory, sessionLogger }) {
  const settings = await getSettings();
  const stepCap = options?.stepCap || STEP_CAP_DEFAULT;
  const tokenLimit = settings.token_limit || 1000000;

  memory.startedAt = memory.startedAt || Date.now();
  memory.setPhase(PHASES.EXECUTING);

  // Visual stagnation tracking
  let prevScreenshotHash = '';
  let consecutiveSameScreen = 0;
  let lastOverlayHint = '';

  try {
    while (!runtime.abortFlag && runtime.step < stepCap) {
      // Pause support
      while (runtime.pauseFlag && !runtime.abortFlag) {
        await setIconMode('paused');
        await sleep(400);
      }
      if (runtime.abortFlag) break;
      await setIconMode('working');

      runtime.step++;
      broadcast({ kind: 'step_start', step: runtime.step });

      // 0) Wait for page readiness
      // ANTI-BLINK: Use fast-track mode after UI interactions (click/hover)
      // to capture dynamic elements (dropdowns, menus) before they disappear
      broadcast({ kind: 'infra', text: '⏳ Ожидание готовности страницы...' });
      try {
        if (runtime._fastTrackMode) {
          broadcast({ kind: 'infra', text: '⚡ Fast-track: пропуск network idle для захвата UI...' });
          await waitPageReadyFast();
          runtime._fastTrackMode = false; // Reset after use
        } else {
          await waitPageReady();
        }
        broadcast({ kind: 'infra', text: '✅ Страница готова' });
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'waitPageReady failed: ' + e.message });
      }

      // 1) Capture screenshot
      let screenshot = null;
      try {
        broadcast({ kind: 'infra', text: '📸 Делаем скриншот...' });
        screenshot = await captureScreenshot();
        broadcast({ kind: 'screenshot_captured', step: runtime.step, hasImage: !!screenshot });
        broadcast({ kind: 'infra', text: '📸 Скриншот получен' });
      } catch (e) {
        broadcast({ kind: 'log', level: 'error', text: 'screenshot failed: ' + e.message });
        await sleep(STEP_DELAY_MS);
        continue;
      }

      if (!screenshot) {
        broadcast({ kind: 'log', level: 'error', text: 'No screenshot captured, retrying...' });
        await sleep(STEP_DELAY_MS);
        continue;
      }

      // 2) Visual stagnation detection
      const currentHash = screenshotHash(screenshot);
      if (currentHash && currentHash === prevScreenshotHash) {
        consecutiveSameScreen++;
      } else {
        consecutiveSameScreen = 0;
      }
      prevScreenshotHash = currentHash;

      if (consecutiveSameScreen >= 8) {
        broadcast({ kind: 'log', level: 'warn', text: `⚠️ Visual stagnation: screen unchanged for ${consecutiveSameScreen} steps. Forcing scroll.` });
        // Auto-scroll as a recovery action
        await executeVisionTool({ tool: 'scroll', direction: 'down', amount: 400 });
        await sleep(800);
        consecutiveSameScreen = 0;
        // Re-capture screenshot after scroll
        try { screenshot = await captureScreenshot(); } catch (_) {}
        prevScreenshotHash = screenshotHash(screenshot);
      }

      // 3) Get current page info for the prompt
      let currentUrl = '';
      let pageTitle = '';
      try {
        const tab = await chrome.tabs.get(runtime.agentTabId);
        currentUrl = tab?.url || '';
        pageTitle = tab?.title || '';
      } catch (_) {}

      // 4) Build vision prompt
      // ADAPTIVE: If we've had 3+ consecutive model timeouts, reduce history
      // to shrink the prompt and increase the chance of a fast response.
      const effectiveHistory = runtime._reducedHistoryMode
        ? runtime.history.slice(-3)
        : runtime.history;
      const hasMemoryContent = memory.scratchpad.length > 0 || memory.navTree.length > 0;
      const userMessage = buildVisionPrompt({
        task: runtime.task,
        userContext: runtime.context,
        currentUrl,
        pageTitle,
        history: effectiveHistory,
        step: runtime.step,
        consecutiveSame: consecutiveSameScreen,
        taskMemoryContext: hasMemoryContent ? memory.toPromptContext() : '',
        overlayHint: lastOverlayHint
      });

      // 5) Call model with screenshot
      let modelText = '';
      let modelCallStart = 0;
      try {
        broadcast({ kind: 'model_call_start', step: runtime.step });
        modelCallStart = Date.now();
        const out = await callModelWithBackoff(settings, userMessage, screenshot, {
          abortCheck: () => runtime.abortFlag,
          onLog: (text) => broadcast({ kind: 'log', text }),
          sessionLogger,
          systemPrompt: VISION_SYSTEM_PROMPT
        });
        modelText = out.content;
        const modelDuration = Date.now() - modelCallStart;
        broadcast({ kind: 'model_call_end', step: runtime.step, duration: modelDuration, tokensUsed: out.tokensUsed || 0 });

        // ============================================================
        // SW SURVIVAL: Handle model timeout gracefully
        // ============================================================
        if (out.timedOut) {
          runtime._modelTimeoutCount++;
          broadcast({
            kind: 'log',
            level: 'warn',
            text: `⏱️ Model timeout #${runtime._modelTimeoutCount} — saving state and continuing (SW survival)`
          });

          // Record timeout in history so the model knows what happened on next attempt
          runtime.history.push({
            action: '[СИСТЕМА] Таймаут модели',
            observation: `Модель не ответила за ${MODEL_TIMEOUT_MS / 1000}сек. Это таймаут #${runtime._modelTimeoutCount}. Сохраняю состояние и перехожу к следующей попытке.`
          });
          if (runtime.history.length > MAX_HISTORY) {
            runtime.history.splice(0, runtime.history.length - MAX_HISTORY);
          }

          // Persist state immediately — the SW may be killed soon
          await saveState(runtime, memory);

          // Adaptive response: escalating severity based on consecutive timeouts
          if (runtime._modelTimeoutCount >= 5) {
            broadcast({ kind: 'log', level: 'error', text: '❌ 5+ consecutive model timeouts — aborting (persistent_model_timeout)' });
            runtime.running = false;
            await setIconMode('error');
            return { ok: false, reason: 'persistent_model_timeout', steps: runtime.step };
          }
          if (runtime._modelTimeoutCount >= 3) {
            broadcast({
              kind: 'log',
              level: 'warn',
              text: `⚠️ ${runtime._modelTimeoutCount} consecutive timeouts — reducing prompt complexity for next attempt`
            });
            // Hint for the next iteration: use reduced history
            runtime._reducedHistoryMode = true;
          }

          await sleep(STEP_DELAY_MS);
          continue; // Skip to next iteration — retry the model call
        }

        // Model responded successfully — reset timeout counter
        runtime._modelTimeoutCount = 0;
        runtime._reducedHistoryMode = false;

        if (out.tokensUsed) {
          runtime.totalTokensUsed += out.tokensUsed;
          if (sessionLogger) sessionLogger.logTokens(out.tokensUsed);
          broadcast({ kind: 'tokens_update', tokensUsed: out.tokensUsed, totalTokensUsed: runtime.totalTokensUsed });
        }
        // Token budget check — hard stop if limit exceeded
        if (runtime.totalTokensUsed >= tokenLimit) {
          broadcast({ kind: 'log', level: 'error', text: `🪙 Token limit reached: ${runtime.totalTokensUsed.toLocaleString()} / ${tokenLimit.toLocaleString()}` });
          runtime.running = false;
          await setIconMode('error');
          return { ok: false, reason: 'token_limit_reached', steps: runtime.step };
        }
        broadcast({ kind: 'log', text: `step ${runtime.step} reply: ${modelText.slice(0, 300)}` });
      } catch (e) {
        broadcast({ kind: 'model_call_end', step: runtime.step, duration: Date.now() - modelCallStart, error: e.message });
        broadcast({ kind: 'log', level: 'error', text: 'model call failed: ' + e.message });
        if (sessionLogger) sessionLogger.logError(e);
        if (e.message === 'aborted') break;
        await saveState(runtime, memory);
        await sleep(STEP_DELAY_MS * 2);
        continue;
      }

      // 6) Parse response
      const action = parseVisionResponse(modelText);
      if (!action) {
        broadcast({ kind: 'log', level: 'error', text: 'unparseable reply, retrying: ' + modelText.slice(0, 200) });
        await saveState(runtime, memory);
        await sleep(STEP_DELAY_MS);
        continue;
      }

      // Extract and broadcast AI's reasoning
      const thought = extractVisionThinking(action);
      if (thought) {
        broadcast({ kind: 'agent_thought', step: runtime.step, thought });
      }

      broadcast({ kind: 'action', step: runtime.step, action });

      // 6b) Save notes to scratchpad if present
      if (action.notes && Array.isArray(action.notes) && action.notes.length > 0) {
        memory.addNotes(action.notes);
        broadcast({ kind: 'log', text: `📝 Saved ${action.notes.length} notes to scratchpad` });
      }

      // 7) Terminal checks (for single actions only — chains check internally)
      if (!action._isChain) {
        if (action.tool === 'done') {
          runtime.running = false;
          await setIconMode('idle');
          return { ok: true, answer: action.answer || '', steps: runtime.step };
        }
        if (action.tool === 'fail') {
          runtime.running = false;
          await setIconMode('error');
          return { ok: false, reason: action.reason || 'model reported failure', steps: runtime.step };
        }
      }

      // 8) Execute tool (single action or chain)
      let observation;
      try {
        if (action._isChain) {
          observation = await executeActionChain(action);
          // Check if chain ended with terminal action (done/fail)
          if (observation.terminal) {
            if (observation.answer) {
              runtime.running = false;
              await setIconMode('idle');
              return { ok: true, answer: observation.answer, steps: runtime.step };
            }
            if (observation.reason) {
              runtime.running = false;
              await setIconMode('error');
              return { ok: false, reason: observation.reason, steps: runtime.step };
            }
          }
        } else {
          observation = await executeVisionTool(action);
        }

        // ANTI-BLINK: Enable fast-track mode for UI interactions (click, hover, select)
        // This tells the next iteration to skip network idle wait and capture
        // the screenshot immediately while dropdowns/menus are still open
        const isUIInteraction = ['click_at', 'hover_at', 'select_at', 'checkbox_at'].includes(action.tool);
        const causedNavigation = observation?.ok && action.tool === 'navigate';

        if (isUIInteraction && !causedNavigation) {
          runtime._fastTrackMode = true;
          runtime._lastActionTool = action.tool;
          broadcast({ kind: 'log', text: `⚡ Fast-track enabled for next screenshot (after ${action.tool})` });
        } else {
          runtime._fastTrackMode = false;
          runtime._lastActionTool = action.tool;
        }
      } catch (e) {
        observation = { ok: false, error: e.message };
        runtime._fastTrackMode = false;
      }

      // 8a) Deep sleep check — if agent entered hibernation, STOP the loop.
      // CDP is detached, heartbeat is stopped, state is saved by persistence.
      // The alarm will fire later and attemptResume will restart this loop.
      if (observation?.ok && observation?.mode === 'deep_sleep') {
        // Push the sleep action into history before stopping
        runtime.history.push({
          action: JSON.stringify(action).slice(0, 500),
          observation: `Глубокая гибернация: ${observation.reason || ''}. Запрошено: ${observation.requestedDurationSec || '?'}сек. Service Worker выгрузится из памяти.`
        });
        if (runtime.history.length > MAX_HISTORY) {
          runtime.history.splice(0, runtime.history.length - MAX_HISTORY);
        }
        // Final save (state already persisted by startDeepSleep, but save history too)
        await saveState(runtime, memory);
        // Return — do NOT clean up state, alarm will resume us
        return { ok: true, reason: 'deep_sleep', steps: runtime.step };
      }

      broadcast({ kind: 'observation', step: runtime.step, observation });

      // Track overlay blockage for the next step's prompt
      if (!observation.ok && observation.error === 'overlay_blocked') {
        lastOverlayHint = observation.hint || '';
      } else {
        lastOverlayHint = ''; // Clear if no blockage
      }

      // 8b) Auto-track navigation: if URL changed after action, create/update nav nodes
      if (observation.ok && action.tool !== 'jump_to_node') {
        try {
          let newUrl = '';
          const tab = await chrome.tabs.get(runtime.agentTabId);
          newUrl = tab?.url || '';

          // If URL changed and we have memory, create a nav node
          if (newUrl && newUrl !== currentUrl && newUrl !== 'about:blank' && memory.navTree) {
            const currentNode = memory.getCurrentNavNode();
            // Don't create duplicate nodes for the same URL
            const existingNode = memory.navTree.find(n => n.url === newUrl);
            if (existingNode) {
              // Just update current to existing node
              memory.currentNodeId = existingNode.id;
              existingNode.status = 'active';
            } else {
              // Determine node type based on URL patterns
              let nodeType = 'LEAF';
              const urlLower = newUrl.toLowerCase();
              if (urlLower.includes('google.com/search') || urlLower.includes('yandex.ru/search') ||
                  urlLower.includes('duckduckgo.com') || urlLower.includes('bing.com/search') ||
                  urlLower.includes('/search') || urlLower.includes('/catalog') || urlLower.includes('/listing')) {
                nodeType = 'HUB';
              }

              // Mark previous node as explored (if it was active)
              if (currentNode && currentNode.status === 'active') {
                currentNode.status = 'explored';
              }

              // Create new node with parent reference
              memory.addNavNode({
                url: newUrl,
                title: pageTitle || '',
                nodeType,
                parentId: currentNode?.id || null,
                status: 'active'
              });

              broadcast({ kind: 'log', text: `🧭 Nav node added: [${memory.currentNodeId}] ${newUrl.slice(0, 80)}` });
            }

            // Broadcast nav tree update for UI
            broadcast({
              kind: 'nav_tree_changed',
              navTree: memory.toStatusPayload().navTree
            });
          }
        } catch (_) {}
      }

      // 9) Log step
      if (sessionLogger) {
        sessionLogger.logStep({
          step: runtime.step,
          phase: memory.phase,
          screenshotDataUrl: screenshot,
          pageInfo: { url: currentUrl, title: pageTitle },
          prompt: userMessage.slice(0, 3000),
          modelResponse: modelText.slice(0, 3000),
          parsedAction: action,
          observation
        });
      }

      // 10) Record history (compact — for action log in next prompt)
      // Special handling for sleep actions: inject rich wake context
      if (action.tool === 'sleep' || action.tool === 'sleep_until_change') {
        const sleepObs = observation;
        let wakeContext = '';
        if (sleepObs.mode === 'deep_sleep') {
          wakeContext = `Пробуждение из глубокой гибернации. Запрошено: ${sleepObs.requestedDurationSec || '?'}сек. Причина сна: ${sleepObs.reason || '?'}. Прошло: ${Math.round((Date.now() - (sleepObs.startedAt || Date.now())) / 1000)}сек.`;
        } else if (sleepObs.mode === 'watchful') {
          const elapsed = sleepObs.elapsedFormatted || `${Math.round((sleepObs.sleepDurationMs || 0) / 1000)}сек`;
          wakeContext = `Сторожевой сон завершён: ${sleepObs.wakeReason || 'unknown'} (${elapsed}). Причина сна: ${sleepObs.reason || '?'}.`;
        }
        runtime.history.push({
          action: JSON.stringify(action).slice(0, 500),
          observation: wakeContext || JSON.stringify(observation).slice(0, 500)
        });
      } else {
        runtime.history.push({
          action: JSON.stringify(action).slice(0, 500),
          observation: JSON.stringify(observation).slice(0, 500)
        });
      }
      if (runtime.history.length > MAX_HISTORY) {
        runtime.history.splice(0, runtime.history.length - MAX_HISTORY);
      }

      // 11) Persist state
      await saveState(runtime, memory);

      // 12) Brief delay
      await sleep(STEP_DELAY_MS);
    }

    // Step cap or abort
    if (runtime.abortFlag) {
      await setIconMode('idle');
      return { ok: false, reason: 'stopped_by_user', steps: runtime.step };
    } else {
      await setIconMode('idle');
      return { ok: false, reason: 'step_cap_reached', steps: runtime.step };
    }
  } catch (e) {
    await setIconMode('error');
    return { ok: false, reason: e.message };
  }
}

// ============================================================
// RESUME: Vision loop resumption after SW wake
// ============================================================

/**
 * Resume the vision loop from persisted state.
 * Called by attemptResume() when the loop type is 'vision'.
 */
export async function resumeVisionLoop({ memory, sessionLogger }) {
  const settings = await getSettings();
  const task = runtime.task;
  const context = runtime.context;
  const options = runtime.options || {};

  return await runVisionLoop({ task, context, options, memory, sessionLogger });
}

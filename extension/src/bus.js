// bus.js — Shared runtime state and utility functions.
//
// Extracted from background.js. Holds:
//   - Shared runtime state (running, paused, step counter, agent tab id, etc.)
//   - Utility functions (sleep, broadcast, setBadge, setIconMode)
//
// All other modules (cdp.js, agent_tab.js, background.js)
// import from here to access shared state and broadcast events.

// ============================================================
// RUNTIME STATE (singleton, shared across all modules)
// ============================================================

export const runtime = {
  running: false,
  paused: false,
  abortFlag: false,
  pauseFlag: false,
  step: 0,
  agentTabId: null,       // chrome tab id of the user's active tab
  task: '',
  context: '',
  history: [],
  options: {},
  startedAt: 0,
  totalTokensUsed: 0,     // accumulated token count from AI model responses
  // CDP state
  cdpAttached: false,
  cdpTarget: null,        // { tabId } or { tabId, frameId }
  // Network idle tracking
  networkRequestCount: 0,
  networkIdleTimer: null,
  networkIdlePromise: null,
  // Persistence: loop type (always 'vision' in v6.0+)
  _loopType: 'vision',
  // Sleep result: context from the last sleep action (for wake-reason injection into history)
  _sleepResult: null,
  // Deep sleep alarm name (for tracking active hibernation alarm)
  _deepSleepAlarmName: null,
  // Force-wake flag: set by UI to interrupt watchful sleep polling loop
  _forceWakeFlag: false,
  // Current sleep info (for UI rehydration on pages loaded mid-sleep)
  _currentSleep: null,
  // Persistence: ephemeral references (NOT serialized, re-created on wake)
  _memory: null,
  _sessionLogger: null,
  _confirmResolve: null,
  // Log buffer (ring buffer for popup to retrieve on re-open)
  _logBuffer: [],
  _logBufferMax: 300
};

/**
 * Restore runtime fields from a persisted state object (from chrome.storage.session).
 * Only overwrites serializable fields — ephemeral references (_memory, _sessionLogger, etc.)
 * and infrastructure state (cdpAttached, networkIdle) are left untouched.
 *
 * @param {Object} state — deserialized state from persistence.loadState()
 */
export function rehydrateRuntime(state) {
  if (!state) return;
  runtime.running = state.running ?? false;
  runtime.pauseFlag = state.pauseFlag ?? false;
  runtime.abortFlag = false; // never persisted — always start clean
  runtime.step = state.step ?? 0;
  runtime.agentTabId = state.agentTabId ?? null;
  runtime.task = state.task ?? '';
  runtime.context = state.context ?? '';
  runtime.history = Array.isArray(state.history) ? state.history : [];
  runtime.options = state.options ?? {};
  runtime.startedAt = state.startedAt ?? 0;
  runtime.totalTokensUsed = state.totalTokensUsed ?? 0;
  runtime._loopType = state.loopType ?? 'vision';
  // Restore sleep result so resume can compute elapsed time and inject wake context
  runtime._sleepResult = state.sleepResult || null;
  // Restore log buffer so UI can show history after SW wake
  runtime._logBuffer = Array.isArray(state.logBuffer) ? state.logBuffer : [];
  // Restore current sleep info so UI can show sleep state after page reload
  runtime._currentSleep = state.currentSleep || null;
  // Mark that this session was resumed (not freshly started)
  runtime._resumed = true;
}

// ============================================================
// CONSTANTS
// ============================================================

export const STEP_CAP_DEFAULT = 200;
export const STEP_DELAY_MS = 1200;
export const MAX_HISTORY = 10;
export const CDP_VERSION = '1.3';

// ============================================================
// UTILITY
// ============================================================

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Generate a random delay that mimics human behavior.
 * Returns a value between `min` and `max` milliseconds.
 * Uses a slight bias toward the middle (Gaussian-like) for more natural timing.
 *
 * @param {number} min — minimum delay in ms (default 80)
 * @param {number} max — maximum delay in ms (default 350)
 * @returns {number} random delay in ms
 */
export function humanDelay(min = 80, max = 350) {
  // Average of 2 random values gives a gentle bell curve centered in the range
  const avg = (Math.random() + Math.random()) / 2;
  return Math.round(min + avg * (max - min));
}

/**
 * Sleep for a human-like random delay.
 * Use between actions in a chain to simulate natural human pace.
 *
 * @param {number} min — minimum delay in ms (default 80)
 * @param {number} max — maximum delay in ms (default 350)
 */
export async function humanSleep(min = 80, max = 350) {
  await sleep(humanDelay(min, max));
}

/**
 * Longer "thinking" pause — simulates a human pausing to read or decide.
 * Use before important actions like form submission or navigation.
 *
 * @param {number} min — minimum delay in ms (default 300)
 * @param {number} max — maximum delay in ms (default 1200)
 */
export async function humanThinkPause(min = 300, max = 1200) {
  await sleep(humanDelay(min, max));
}

/**
 * Broadcast an event to all listening extension pages (popup, logs, agent tab).
 * Every message gets a timestamp and is prefixed with kind='agent_event'.
 */
export function broadcast(msg) {
  msg = { ...msg, ts: Date.now() };
  // Buffer important events so popup can restore state on re-open
  if (msg.kind === 'log' || msg.kind === 'action' || msg.kind === 'observation' ||
      msg.kind === 'phase_changed' ||
      msg.kind === 'finished' ||
      msg.kind === 'step_start' || msg.kind === 'tokens_update' ||
      msg.kind === 'started' ||
      msg.kind === 'resumed_after_interrupt' ||
      msg.kind === 'agent_thought' || msg.kind === 'model_call_start' ||
      msg.kind === 'model_call_end' || msg.kind === 'api_call' ||
      msg.kind === 'infra' || msg.kind === 'screenshot_captured' ||
      msg.kind === 'sleep_started' || msg.kind === 'sleep_ended' || msg.kind === 'force_wake') {
    runtime._logBuffer.push(msg);
    if (runtime._logBuffer.length > runtime._logBufferMax) {
      runtime._logBuffer.splice(0, runtime._logBuffer.length - runtime._logBufferMax);
    }
  }
  // popup
  chrome.runtime.sendMessage({ _agentEvent: true, ...msg }).catch(() => {});
  // log page (lives in extension pages, so use tabs.sendMessage to all extension pages)
  chrome.tabs.query({ url: chrome.runtime.getURL('src/logs.html') }, (tabs) => {
    for (const t of tabs || []) {
      chrome.tabs.sendMessage(t.id, { _agentEvent: true, ...msg }).catch(() => {});
    }
  });
  // overlay widget on all pages (content scripts)
  // NOTE: do NOT skip agentTabId here — in Direct Tab mode the agent tab IS
  // the user's active tab, and the overlay widget there needs to receive events.
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs || []) {
      chrome.tabs.sendMessage(t.id, { _agentEvent: true, ...msg }).catch(() => {});
    }
  });
}

// ============================================================
// BADGE / ICON
// ============================================================

export async function setBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color: color || '#2563eb' });
    await chrome.action.setBadgeText({ text: String(text || '').slice(0, 6) });
  } catch (_) {}
}

export async function setIconMode(mode) {
  // mode: 'idle' | 'working' | 'paused' | 'sleeping' | 'waiting' | 'error'
  const color =
    mode === 'working' ? '#16a34a' :
    mode === 'waiting' ? '#0ea5e9' :
    mode === 'sleeping' ? '#6366f1' :  // indigo — peaceful sleep
    mode === 'paused'  ? '#ca8a04' :
    mode === 'error'   ? '#dc2626' : '#374151';
  await setBadge(runtime.step > 0 ? String(runtime.step) : '·', color);
}

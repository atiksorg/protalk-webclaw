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
  // Fast-track mode: skip network idle wait after UI interactions (click/hover)
  // to capture dynamic elements (dropdowns, menus) before they disappear
  _fastTrackMode: false,
  // Last action type: used to determine if fast-track should activate
  _lastActionTool: null,
  // Mouse parking coordinates: keep cursor at click position to prevent mouseleave
  _mouseParkCoords: null,
  // Model timeout tracking: counts consecutive model call timeouts (>25s)
  // Used by vision_loop.js to adaptively reduce prompt size or abort gracefully.
  // Reset to 0 on successful model response.
  _modelTimeoutCount: 0,
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
  // Restore deep sleep alarm name (for tracking active hibernation alarm after SW wake)
  runtime._deepSleepAlarmName = state.deepSleepAlarmName || null;
  // Restore model timeout counter for adaptive prompt reduction
  runtime._modelTimeoutCount = state.modelTimeoutCount || 0;
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
// Timeout for AI model API calls (in milliseconds).
// Set to 25 seconds — slightly under Chrome's ~30s SW kill threshold.
// Prevents the service worker from being killed mid-request.
export const MODEL_TIMEOUT_MS = 25000;

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

// ============================================================
// MOUSE TRAJECTORY — Human-like Bezier curve movement
// ============================================================

/**
 * Generate random jitter to simulate hand tremor.
 * Returns a small offset (±jitterAmount pixels) using Gaussian-like distribution.
 *
 * @param {number} jitterAmount — max deviation in pixels (default 1.5)
 * @returns {{ jx: number, jy: number }}
 */
export function mouseJitter(jitterAmount = 1.5) {
  // Box-Muller transform for Gaussian-like distribution (clamped)
  const u1 = Math.random() || 0.001;
  const u2 = Math.random();
  const g1 = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const g2 = Math.sqrt(-2 * Math.log(u1)) * Math.sin(2 * Math.PI * u2);
  return {
    jx: Math.round(g1 * jitterAmount * 10) / 10,
    jy: Math.round(g2 * jitterAmount * 10) / 10
  };
}

/**
 * Generate cubic Bezier control points for a human-like curved path
 * from (x1, y1) to (x2, y2).
 *
 * The control points are placed near the midpoint but offset perpendicular
 * to the straight line, creating a natural slight arc. The arc direction
 * and magnitude are randomized to avoid detectable patterns.
 *
 * @param {number} x1 — start X
 * @param {number} y1 — start Y
 * @param {number} x2 — end X
 * @param {number} y2 — end Y
 * @param {number} curvature — max perpendicular offset (default 50–120px)
 * @returns {{ cp1x: number, cp1y: number, cp2x: number, cp2y: number }}
 */
export function generateBezierControlPoints(x1, y1, x2, y2, curvature) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Curvature scales with distance: short moves are nearly straight,
  // long moves get a noticeable arc (human arm sweeps wider arcs)
  const maxCurve = curvature ?? Math.min(120, Math.max(15, dist * 0.15));

  // Perpendicular unit vector (randomly flipped left/right)
  const perpX = -dy / (dist || 1);
  const perpY = dx / (dist || 1);
  const side = Math.random() > 0.5 ? 1 : -1;
  const offset = side * (maxCurve * (0.4 + Math.random() * 0.6));

  // Place control points at roughly 1/3 and 2/3 of the distance
  // with perpendicular offset — this creates a natural S-curve or arc
  const cp1x = Math.round(x1 + dx * 0.3 + perpX * offset * (0.6 + Math.random() * 0.4));
  const cp1y = Math.round(y1 + dy * 0.3 + perpY * offset * (0.6 + Math.random() * 0.4));
  const cp2x = Math.round(x1 + dx * 0.7 + perpX * offset * (0.3 + Math.random() * 0.5));
  const cp2y = Math.round(y1 + dy * 0.7 + perpY * offset * (0.3 + Math.random() * 0.5));

  return { cp1x, cp1y, cp2x, cp2y };
}

/**
 * Evaluate a cubic Bezier curve at parameter t ∈ [0, 1].
 *
 * @param {number} t — curve parameter (0 = start, 1 = end)
 * @param {number} p0 — start value
 * @param {number} p1 — control point 1
 * @param {number} p2 — control point 2
 * @param {number} p3 — end value
 * @returns {number} interpolated value
 */
export function cubicBezier(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Human-like easing function: starts fast, decelerates near the target.
 * This mimics the natural Fitts' Law movement profile where humans
 * move quickly at first, then slow down to "aim" at the target.
 *
 * @param {number} t — linear progress [0, 1]
 * @returns {number} eased progress [0, 1]
 */
export function easeOutQuad(t) {
  return t * (2 - t);
}

/**
 * Generate the full sequence of points along a human-like curved path
 * from (x1, y1) to (x2, y2), with jitter and easing.
 *
 * Returns an array of { x, y, delay } objects ready to be dispatched
 * as CDP Input.dispatchMouseEvent calls.
 *
 * @param {number} x1 — start X in viewport pixels
 * @param {number} y1 — start Y in viewport pixels
 * @param {number} x2 — end X in viewport pixels
 * @param {number} y2 — end Y in viewport pixels
 * @param {Object} [opts] — configuration overrides
 * @param {number} [opts.steps] — number of intermediate points (default 15–20)
 * @param {number} [opts.jitter] — jitter amount in pixels (default 1.5)
 * @param {number} [opts.curvature] — max arc offset (default: auto-scaled)
 * @param {number} [opts.baseDelay] — base inter-point delay in ms (default 8–16)
 * @returns {Array<{x: number, y: number, delay: number}>} movement path
 */
export function generateMousePath(x1, y1, x2, y2, opts = {}) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Very short movements (< 5px): just one step, no curve needed
  if (dist < 5) {
    return [{ x: Math.round(x2), y: Math.round(y2), delay: 0 }];
  }

  // Number of steps scales with distance:
  // short: ~8-12, medium: ~15, long: ~20 (never exceeds 25 for perf)
  const defaultSteps = Math.min(25, Math.max(8, Math.round(dist / 50) + 5));
  const steps = opts.steps || defaultSteps;

  // Generate Bezier control points
  const { cp1x, cp1y, cp2x, cp2y } = generateBezierControlPoints(x1, y1, x2, y2, opts.curvature);

  const jitterAmount = opts.jitter ?? 1.5;
  const baseDelay = opts.baseDelay ?? 10; // ms between points

  const path = [];

  for (let i = 1; i <= steps; i++) {
    // Linear parameter [0, 1]
    const tLinear = i / steps;

    // Apply easing: accelerate quickly, then decelerate for aiming
    const tEased = easeOutQuad(tLinear);

    // Evaluate Bezier at eased parameter
    let px = cubicBezier(tEased, x1, cp1x, cp2x, x2);
    let py = cubicBezier(tEased, y1, cp1y, cp2y, y2);

    // Add jitter (skip on last step — we want to land precisely on target)
    if (i < steps) {
      const { jx, jy } = mouseJitter(jitterAmount);
      px += jx;
      py += jy;
    } else {
      // Final step: snap exactly to target (no jitter)
      px = x2;
      py = y2;
    }

    // Inter-step delay: shorter in the fast middle phase, longer at start and end
    // Sine curve gives: short→medium→long feel
    const delayFactor = 0.5 + 0.5 * Math.sin(Math.PI * tLinear); // peaks at t=0.5
    const delay = Math.round(baseDelay * (0.6 + delayFactor * 0.8));

    path.push({
      x: Math.round(Math.max(0, px)),
      y: Math.round(Math.max(0, py)),
      delay
    });
  }

  return path;
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

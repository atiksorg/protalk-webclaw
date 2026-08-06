// cdp.js — Chrome DevTools Protocol layer.
//
// Manages CDP attachment, screenshot capture, trusted input events (click/type/scroll/keypress),
// network idle detection, and DOM stability checks.
//
// Extracted from background.js to separate infrastructure concerns from agent logic.

import { runtime, sleep, broadcast, CDP_VERSION } from './bus.js';
import { getSettings } from './settings.js';
import { generateMousePath } from './bus.js';

// ============================================================
// CDP LIFECYCLE
// ============================================================

// Track consecutive detach count to prevent infinite detach→reattach cycles
let _consecutiveDetaches = 0;
const MAX_DETACH_REATTACH = 3;

/**
 * Reset the consecutive detach counter (called on successful attach or when starting a new session).
 */
export function resetCdpDetachCounter() {
  _consecutiveDetaches = 0;
}

/**
 * Attach to the agent tab via CDP. This enables:
 * - Page.captureScreenshot (works even when tab is not active)
 * - Input.dispatchMouseEvent / Input.dispatchKeyEvent (trusted, isTrusted:true)
 * - Network domain events for idle detection
 * - Page lifecycle events
 */
export async function cdpAttach(tabId) {
  if (runtime.cdpAttached && runtime.cdpTarget?.tabId === tabId) {
    return; // already attached
  }
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
    runtime.cdpAttached = true;
    runtime.cdpTarget = { tabId };
    _consecutiveDetaches = 0; // Reset counter on successful attach
    broadcast({ kind: 'log', text: `CDP attached to tab ${tabId}` });
  } catch (e) {
    // May already be attached by another debugger
    if (e.message && e.message.includes('already attached')) {
      runtime.cdpAttached = true;
      runtime.cdpTarget = { tabId };
      _consecutiveDetaches = 0;
    } else {
      broadcast({ kind: 'log', level: 'error', text: `CDP attach failed: ${e.message}` });
      throw e;
    }
  }
}

/** Detach CDP from the current tab. */
export async function cdpDetach() {
  if (!runtime.cdpAttached || !runtime.cdpTarget) return;
  try {
    await chrome.debugger.detach(runtime.cdpTarget);
  } catch (_) {}
  runtime.cdpAttached = false;
  runtime.cdpTarget = null;
  // Cursor position becomes unknown after detach
  _lastMousePos = null;
}

/** Send a CDP command and return the result. */
export async function cdpSend(method, params = {}) {
  if (!runtime.cdpAttached || !runtime.cdpTarget) {
    throw new Error('cdp_not_attached');
  }
  try {
    return await chrome.debugger.sendCommand(runtime.cdpTarget, method, params);
  } catch (e) {
    // If detached, try to reattach once
    if (e.message && (e.message.includes('Detached') || e.message.includes('not attached'))) {
      if (runtime.agentTabId) {
        await cdpAttach(runtime.agentTabId);
        return await chrome.debugger.sendCommand(runtime.cdpTarget, method, params);
      }
    }
    throw e;
  }
}

// ============================================================
// MOUSE POSITION TRACKING
// ============================================================

// Track the last known cursor position so we can move FROM it.
// null = unknown (first move in session, or after SW wake).
let _lastMousePos = null;

/**
 * Reset mouse position tracking (e.g. on session start or tab switch).
 * The next cdpMoveMouse/cdpClick/cdpHover will use a short random start
 * position instead of interpolating from a stale point.
 */
export function resetMousePosition() {
  _lastMousePos = null;
}

/**
 * Move the mouse cursor from its current position to (targetX, targetY)
 * along a human-like Bezier curve with jitter and easing.
 *
 * Dispatches 15–20 CDP Input.dispatchMouseEvent(mouseMoved) commands
 * with micro-delays between them. This creates a natural movement
 * trajectory that anti-bot systems cannot distinguish from a real human.
 *
 * If the current cursor position is unknown (first move or after SW wake),
 * the cursor starts from a random point within ~200px of the target.
 *
 * @param {number} targetX — destination X in viewport pixels
 * @param {number} targetY — destination Y in viewport pixels
 * @param {Object} [opts] — optional overrides (steps, jitter, curvature, baseDelay)
 */
export async function cdpMoveMouse(targetX, targetY, opts) {
  // Determine start position
  let startX, startY;
  if (_lastMousePos) {
    startX = _lastMousePos.x;
    startY = _lastMousePos.y;
  } else {
    // First move in session: start from a random nearby point to avoid
    // the "teleport from (0,0)" tell. Place cursor ~100-200px from target
    // at a random angle — simulates a cursor that was "already somewhere on screen".
    const angle = Math.random() * Math.PI * 2;
    const dist = 100 + Math.random() * 150;
    startX = Math.round(targetX + Math.cos(angle) * dist);
    startY = Math.round(targetY + Math.sin(angle) * dist);
  }

  // Compute distance — if very close (< 5px), just send one move event
  const dx = targetX - startX;
  const dy = targetY - startY;
  const distance = Math.sqrt(dx * dx + dy * dy);

  if (distance < 5) {
    // Already at target — just one precise mouseMoved
    await cdpSend('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: targetX, y: targetY, button: 'none', clickCount: 0
    });
    _lastMousePos = { x: targetX, y: targetY };
    return;
  }

  // Generate the human-like Bezier path
  const settings = await getSettings().catch(() => ({}));
  const pathOpts = {
    jitter: (settings.mouse_move_jitter != null) ? settings.mouse_move_jitter : 1.5,
    baseDelay: (settings.mouse_move_base_delay != null) ? settings.mouse_move_base_delay : 10,
    ...opts // caller overrides take priority
  };

  const path = generateMousePath(startX, startY, targetX, targetY, pathOpts);

  // Dispatch each point as a CDP mouseMoved event
  for (const point of path) {
    if (point.delay > 0) {
      await sleep(point.delay);
    }
    try {
      await cdpSend('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: point.x,
        y: point.y,
        button: 'none',
        clickCount: 0
      });
    } catch (_) {
      // Non-fatal: CDP may have detached mid-movement
      break;
    }
  }

  // Update position tracker
  _lastMousePos = { x: targetX, y: targetY };
}

// ============================================================
// CDP-BASED ACTIONS (trusted events via chrome.debugger)
// ============================================================

/**
 * Perform a trusted click via CDP Input.dispatchMouseEvent.
 * This generates isTrusted:true events that bypass anti-bot checks.
 *
 * HUMAN-LIKE: First moves the cursor along a Bezier curve to the target
 * coordinates, simulating natural hand movement. Then performs the
 * click (press + release) at the precise target point.
 *
 * ANTI-BLINK: After the click sequence, the cursor is "parked" at the
 * click coordinates (a final mouseMoved event). This prevents mouseleave
 * events from firing on custom dropdowns/menus, keeping them open long
 * enough for the agent to screenshot the expanded state.
 */
export async function cdpClick(x, y) {
  // HUMAN-LIKE: Smooth Bezier movement to target before clicking
  await cdpMoveMouse(x, y);

  // Click sequence: press → release (cursor is already at target from cdpMoveMouse)
  await sleep(50);
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', clickCount: 1
  });
  await sleep(50);
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', clickCount: 1
  });

  // ANTI-BLINK: Park the cursor at click position to prevent mouseleave.
  // This keeps custom dropdowns/menus open after the click.
  // We send a final mouseMoved to the same coordinates after a tiny delay.
  await sleep(10);
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x, y, button: 'none', clickCount: 0
  }).catch(() => {}); // non-critical, safe to ignore errors

  // Store park coordinates so other modules know where the cursor is
  runtime._mouseParkCoords = { x, y };
}

/**
 * Perform trusted keyboard input via CDP Input.insertText.
 * Uses the dedicated CDP insertText command which correctly handles
 * any Unicode characters: Cyrillic, CJK, emoji, special symbols, etc.
 */
export async function cdpType(text) {
  await cdpSend('Input.insertText', { text });
}

/**
 * Perform a trusted hover via CDP Input.dispatchMouseEvent.
 * Moves the mouse to (x, y) and holds position — triggers :hover CSS,
 * reveals dropdown menus, shows tooltips, etc.
 *
 * HUMAN-LIKE: Moves along a Bezier curve before hovering.
 */
export async function cdpHover(x, y) {
  // HUMAN-LIKE: Smooth Bezier movement to target before hovering
  await cdpMoveMouse(x, y);
}

/**
 * Perform a trusted key press via CDP.
 */
export async function cdpPressKey(key) {
  const keyMap = {
    'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
    'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
    'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
    'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
    'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
    'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    'Space': { key: ' ', code: 'Space', keyCode: 32 }
  };
  const k = keyMap[key] || { key, code: key, keyCode: key.charCodeAt(0) };
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyDown', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode
  });
  await sleep(30);
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyUp', key: k.key, code: k.code,
    windowsVirtualKeyCode: k.keyCode,
    nativeVirtualKeyCode: k.keyCode
  });
}

// ============================================================
// SCREENSHOT VIA CDP (works in background, no tab focus needed)
// ============================================================

// ============================================================
// OVERLAY HIDING — hide extension UI before screenshots
// ============================================================

// CDP expression to hide the overlay widget (content script element)
const OVERLAY_HIDE_SCRIPT = `(function(){
  var el = document.getElementById('webclaw-overlay');
  if (el) el.classList.add('webclaw-cdp-hidden');
})()`;

// CDP expression to restore the overlay widget after screenshot
const OVERLAY_SHOW_SCRIPT = `(function(){
  var el = document.getElementById('webclaw-overlay');
  if (el) el.classList.remove('webclaw-cdp-hidden');
})()`;

/**
 * Hide the WebClaw overlay widget on the agent tab via CDP.
 * Safe: silently ignores errors (element may not exist on the page).
 */
async function hideOverlayForScreenshot() {
  try {
    await cdpSend('Runtime.evaluate', {
      expression: OVERLAY_HIDE_SCRIPT,
      returnByValue: true
    });
  } catch (_) {}
}

/**
 * Restore the WebClaw overlay widget on the agent tab via CDP.
 * Safe: silently ignores errors.
 */
async function showOverlayAfterScreenshot() {
  try {
    await cdpSend('Runtime.evaluate', {
      expression: OVERLAY_SHOW_SCRIPT,
      returnByValue: true
    });
  } catch (_) {}
}

/**
 * Capture screenshot using CDP Page.captureScreenshot.
 * Falls back to captureVisibleTab if CDP is not available.
 * Returns a data:image/png;base64,... URL.
 *
 * IMPORTANT: Automatically hides the WebClaw overlay widget before
 * capturing and restores it afterwards, so the AI model sees a clean
 * page without extension UI elements.
 */
export async function captureScreenshot() {
  if (!runtime.agentTabId) throw new Error('no_agent_tab');

  // Try CDP screenshot first (works even when tab is not active)
  if (runtime.cdpAttached) {
    try {
      // Hide overlay widget before screenshot so AI doesn't see it
      await hideOverlayForScreenshot();
      // Wait for the browser to actually repaint the frame without the widget.
      // requestAnimationFrame guarantees one paint cycle completed; two calls
      // ensure the compositor has processed the DOM change (display:none).
      await cdpSend('Runtime.evaluate', {
        expression: `new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`,
        returnByValue: true,
        awaitPromise: true
      }).catch(() => sleep(100)); // fallback if RAF fails in CDP context

      const result = await cdpSend('Page.captureScreenshot', {
        format: 'png',
        quality: 85,
        captureBeyondViewport: false
      });

      // Restore overlay immediately after screenshot
      await showOverlayAfterScreenshot();

      if (result?.data) {
        return 'data:image/png;base64,' + result.data;
      }
    } catch (e) {
      // Restore overlay even if screenshot failed
      await showOverlayAfterScreenshot();
      broadcast({ kind: 'log', level: 'error', text: 'CDP screenshot failed: ' + e.message });
    }
  }

  // Fallback: captureVisibleTab (requires tab to be active)
  // For fallback path, also try to hide overlay via scripting API
  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
    await sleep(200);

    // Try to hide overlay via scripting API (fallback path)
    try {
      await chrome.scripting.executeScript({
        target: { tabId: runtime.agentTabId },
        func: () => {
          const el = document.getElementById('webclaw-overlay');
          if (el) el.classList.add('webclaw-cdp-hidden');
        }
      });
    } catch (_) {}

    const screenshot = await chrome.tabs.captureVisibleTab(runtime.agentTabId, { format: 'png' });

    // Restore overlay
    try {
      await chrome.scripting.executeScript({
        target: { tabId: runtime.agentTabId },
        func: () => {
          const el = document.getElementById('webclaw-overlay');
          if (el) el.classList.remove('webclaw-cdp-hidden');
        }
      });
    } catch (_) {}

    return screenshot;
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: 'captureVisibleTab failed: ' + e.message });
    if (/No window/i.test(e.message)) {
      try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
      await sleep(500);
      return await chrome.tabs.captureVisibleTab(runtime.agentTabId, { format: 'png' });
    }
    throw e;
  }
}

// ============================================================
// NETWORK IDLE DETECTION
// ============================================================

// Singleton listener reference — prevents duplicate registration on repeated agent runs.
let _networkListenerAttached = false;
let _networkEventListener = null;

/**
 * Enable CDP Network domain and start tracking request count.
 * Network idle = 0 in-flight requests for `idleMs` milliseconds.
 * Safe to call multiple times — idempotent.
 */
export function setupNetworkIdleTracking() {
  if (_networkListenerAttached) return;

  _networkEventListener = (_source, method, _params) => {
    if (!runtime.cdpAttached) return;
    if (method === 'Network.requestWillBeSent') {
      runtime.networkRequestCount++;
      clearTimeout(runtime.networkIdleTimer);
      runtime.networkIdleTimer = null;
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      runtime.networkRequestCount = Math.max(0, runtime.networkRequestCount - 1);
      if (runtime.networkRequestCount === 0 && !runtime.networkIdleTimer) {
        runtime.networkIdleTimer = setTimeout(() => {
          if (runtime.networkIdlePromise) {
            runtime.networkIdlePromise.resolve();
            runtime.networkIdlePromise = null;
          }
        }, 500);
      }
    }
  };

  chrome.debugger.onEvent.addListener(_networkEventListener);
  _networkListenerAttached = true;
}

/** Tear down network idle listener and reset counters. */
export function removeNetworkIdleTracking() {
  if (_networkListenerAttached && _networkEventListener) {
    try { chrome.debugger.onEvent.removeListener(_networkEventListener); } catch (_) {}
    _networkListenerAttached = false;
    _networkEventListener = null;
  }
  runtime.networkRequestCount = 0;
  clearTimeout(runtime.networkIdleTimer);
  runtime.networkIdleTimer = null;
}

/** Wait for network to be idle (no pending requests for 500ms). */
export async function waitForNetworkIdle(timeoutMs = 10000) {
  try {
    await cdpSend('Network.enable');
  } catch (_) {}

  if (runtime.networkRequestCount === 0) {
    await sleep(300);
    if (runtime.networkRequestCount === 0) return;
  }

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      runtime.networkIdlePromise = null;
      resolve();
    }, timeoutMs);

    runtime.networkIdlePromise = {
      resolve: () => { clearTimeout(timer); resolve(); }
    };
  });
}

// ============================================================
// DOM STABILITY DETECTION
// ============================================================

/**
 * Wait for DOM to stabilize: no mutations for `stableMs` milliseconds.
 */
export async function waitForDomStability(timeoutMs = 8000, stableMs = 300) {
  const start = Date.now();

  // Check readyState
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await cdpSend('Runtime.evaluate', {
        expression: 'document.readyState',
        returnByValue: true
      });
      if (result?.result?.value === 'complete') break;
    } catch (_) {
      break;
    }
    await sleep(200);
  }

  // Wait for DOM stabilization period
  await sleep(stableMs);
}

// ============================================================
// COMBINED WAIT: readyState + network idle + DOM stable
// ============================================================

/**
 * Comprehensive page readiness check before each agent step:
 * 1. document.readyState === 'complete'
 * 2. Network idle: no XHR/Fetch for 500ms
 * 3. DOM stable: no mutations for 300ms
 */
export async function waitPageReady() {
  const settings = await getSettings();
  const networkIdleMs = settings.spa_network_idle_ms || 500;
  const domStableMs = settings.spa_dom_stable_ms || 300;

  // 1. ReadyState
  await waitForDomStability(10000, 0);

  // 2. Network idle
  try {
    await waitForNetworkIdle(8000);
  } catch (_) {
    await sleep(networkIdleMs);
  }

  // 3. DOM stability
  await sleep(domStableMs);
}

/**
 * FAST-TRACK page readiness: minimal wait for dynamic UI elements.
 *
 * Used after click/hover actions where the goal is to capture a
 * dropdown/menu/tooltip BEFORE it disappears (anti-blink strategy).
 *
 * Unlike waitPageReady(), this skips:
 * - Network idle detection (analytics/ads don't matter for UI state)
 * - DOM stability check (mutations are expected during animations)
 *
 * Only waits for the browser's next paint frame (~16ms) plus a small
 * configurable delay for CSS transitions to complete.
 *
 * @param {number} extraDelayMs — additional delay after paint (default: from settings)
 */
export async function waitPageReadyFast(extraDelayMs) {
  try {
    const settings = await getSettings();
    const delay = extraDelayMs ?? (settings.fast_track_delay_ms || 100);

    // Minimal wait: just ensure readyState is at least 'interactive'
    // (don't wait for 'complete' — resources may still be loading)
    const start = Date.now();
    while (Date.now() - start < 1000) {
      try {
        const result = await cdpSend('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true
        });
        if (result?.result?.value === 'interactive' || result?.result?.value === 'complete') {
          break;
        }
      } catch (_) {
        break;
      }
      await sleep(16); // ~1 frame at 60fps
    }

    // Small delay for CSS transitions/animations to settle
    // (dropdown menus typically animate in 150-300ms)
    await sleep(delay);
  } catch (_) {
    // Fallback: just a tiny delay
    await sleep(50);
  }
}

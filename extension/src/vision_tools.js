// vision_tools.js — Universal Vision-First action execution layer.
//
// All actions use NORMALIZED coordinates (0–1000) from the AI model,
// which are scaled to the actual viewport dimensions before dispatching
// via CDP (Chrome DevTools Protocol) trusted events.
//
// This eliminates the need for CSS selectors entirely — the AI "sees"
// the screenshot and clicks/types at what it sees.
//
// Toolset:
//   click_at       — Click at normalized (x, y)
//   right_click_at — Right-click at normalized (x, y)
//   type_at        — Click at (x, y), clear field, type text
//   paste_text     — Click at (x, y), paste text via clipboard (Ctrl+V)
//   press_key      — Keyboard key press
//   scroll         — Scroll at (x, y) in a direction
//   hover_at       — Hover at (x, y)
//   select_at      — Select dropdown option at (x, y)
//   checkbox_at    — Toggle checkbox/radio at (x, y)
//   navigate       — Navigate to URL
//   back           — History back
//   wait           — Wait N seconds
//   done           — Task complete
//   fail           — Task failed

import { runtime, sleep, humanDelay, humanSleep, humanThinkPause, broadcast, setIconMode, mouseJitter } from './bus.js';
import {
  cdpClick, cdpRightClick, cdpType, cdpPressKey, cdpHover, cdpSend,
  cdpAttach, cdpDetach,
  waitPageReady, captureScreenshot
} from './cdp.js';
import { PHASES } from './task_memory.js';
import { getSettings } from './settings.js';
import { startDeepSleep as persistDeepSleep, stopHeartbeat } from './persistence.js';
import { rememberEvent, recallEvents } from './persistent_memory.js';

// ============================================================
// HUMAN-LIKE SWIPE GENERATOR
// ============================================================

/**
 * Generate a human-like swipe path with natural movement characteristics.
 *
 * Human swipe behavior consists of several phases:
 *   Phase 1: Acceleration (0–20%) — finger quickly gains speed
 *   Phase 2: Constant velocity (20–70%) — main movement with slight jitter
 *   Phase 3: Deceleration (70–90%) — finger slows down
 *   Phase 4: Release slide (90–100%) — slight inertia after "lifting" finger
 *
 * Additional humanization:
 *   - Jitter: micro-tremor of the finger (±1–3px random offset)
 *   - Trajectory curve: not perfectly straight, slight arc (Bezier)
 *   - Micro-pauses: occasional 10–30ms hesitations (simulates muscle fatigue)
 *   - Speed variation: sinusoidal speed modulation (±15%)
 *
 * @param {number} x0 — start X in pixels
 * @param {number} y0 — start Y in pixels
 * @param {number} x1 — end X in pixels
 * @param {number} y1 — end Y in pixels
 * @param {Object} [opts] — configuration
 * @param {number} [opts.steps] — number of interpolation points (default: 15–25)
 * @param {number} [opts.jitter] — jitter amount in pixels (default: 1.5–3)
 * @param {number} [opts.durationMs] — total swipe duration in ms (default: 300–450)
 * @param {number} [opts.curvature] — trajectory curvature (default: auto-scaled)
 * @param {number} [opts.microPauseChance] — probability of micro-pause per step (default: 0.08)
 * @param {boolean} [opts.inertia] — add release slide at the end (default: true)
 * @returns {Array<{x: number, y: number, delay: number, phase: string}>}
 */
export function generateHumanSwipePath(x0, y0, x1, y1, opts = {}) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Too short distance: just one step
  if (dist < 5) {
    return [{ x: Math.round(x1), y: Math.round(y1), delay: 0, phase: 'instant' }];
  }

  // Steps scale with distance
  const defaultSteps = Math.min(30, Math.max(12, Math.round(dist / 30) + 5));
  const steps = opts.steps || defaultSteps;

  // Jitter amount (in pixels): scales slightly with distance
  const jitter = opts.jitter ?? Math.min(3, Math.max(1, dist * 0.005));

  // Total duration with slight randomization
  const baseDuration = opts.durationMs ?? (250 + Math.random() * 200); // 250–450ms
  const avgDelay = baseDuration / steps;

  // Curvature: perpendicular offset for Bezier (slight arc, like real hand movement)
  const maxCurve = opts.curvature ?? Math.min(40, Math.max(5, dist * 0.03));
  const perpX = -dy / (dist || 1);
  const perpY = dx / (dist || 1);
  const side = Math.random() > 0.5 ? 1 : -1;
  const curveOffset = side * maxCurve * (0.3 + Math.random() * 0.7);

  // Generate Bezier control points (slight arc)
  const cp1x = x0 + dx * 0.3 + perpX * curveOffset * 0.6;
  const cp1y = y0 + dy * 0.3 + perpY * curveOffset * 0.6;
  const cp2x = x0 + dx * 0.7 + perpX * curveOffset * 0.3;
  const cp2y = y0 + dy * 0.7 + perpY * curveOffset * 0.3;

  // Micro-pause chance
  const microPauseChance = opts.microPauseChance ?? 0.08;

  // Phase thresholds (normalized 0–1)
  const PHASE_ACCEL_END = 0.2;
  const PHASE_CONST_END = 0.7;
  const PHASE_DECEL_END = 0.9;

  const path = [];

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;

    // Determine phase
    let phase;
    if (t < PHASE_ACCEL_END) phase = 'accel';
    else if (t < PHASE_CONST_END) phase = 'const';
    else if (t < PHASE_DECEL_END) phase = 'decel';
    else phase = 'release';

    // === Speed modulation per phase ===
    // Phase 1 (acceleration): starts slow, speeds up (ease-in)
    // Phase 2 (constant): slight sinusoidal variation (±15%)
    // Phase 3 (deceleration): slows down (ease-out)
    // Phase 4 (release): very slow inertia slide

    let speedFactor;
    let delay;

    if (phase === 'accel') {
      // Ease-in: speed increases quadratically
      const phaseT = t / PHASE_ACCEL_END;
      speedFactor = 0.5 + phaseT * 1.5; // 0.5x → 2x speed
      delay = Math.round(avgDelay / speedFactor);
    } else if (phase === 'const') {
      // Constant with sinusoidal variation (simulates muscle micro-adjustments)
      const phaseT = (t - PHASE_ACCEL_END) / (PHASE_CONST_END - PHASE_ACCEL_END);
      const sineModulation = Math.sin(phaseT * Math.PI * 2) * 0.15; // ±15%
      speedFactor = 1.0 + sineModulation;
      delay = Math.round(avgDelay / speedFactor);
    } else if (phase === 'decel') {
      // Ease-out: speed decreases
      const phaseT = (t - PHASE_CONST_END) / (PHASE_DECEL_END - PHASE_CONST_END);
      speedFactor = 1.5 - phaseT * 1.0; // 1.5x → 0.5x
      delay = Math.round(avgDelay / speedFactor);
    } else {
      // Release: very slow inertia (finger lifting off)
      const phaseT = (t - PHASE_DECEL_END) / (1 - PHASE_DECEL_END);
      speedFactor = 0.3 + phaseT * 0.1; // 0.3x → 0.2x (very slow)
      delay = Math.round(avgDelay / speedFactor * 2); // much slower
    }

    // === Bezier interpolation ===
    const mt = 1 - t;
    let px = mt * mt * mt * x0 + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * x1;
    let py = mt * mt * mt * y0 + 3 * mt * mt * t * cp1y + 3 * mt * t * t * cp2y + t * t * t * y1;

    // === Jitter (micro-tremor) ===
    // Skip jitter on first and last points (precise start/end)
    if (i > 0 && i < steps) {
      const { jx, jy } = mouseJitter(jitter);
      px += jx;
      py += jy;
    } else if (i === steps) {
      // Final point: snap exactly to target
      px = x1;
      py = y1;
    }

    // === Micro-pause ===
    let microPause = 0;
    if (i > 1 && i < steps - 1 && Math.random() < microPauseChance) {
      microPause = Math.round(10 + Math.random() * 25); // 10–35ms hesitation
    }

    path.push({
      x: Math.round(Math.max(0, px)),
      y: Math.round(Math.max(0, py)),
      delay: Math.max(1, delay + microPause),
      phase,
      microPause: microPause > 0
    });
  }

  return path;
}

/**
 * Send touch events for a swipe path via CDP.
 * Used for mobile/PWA sites that listen to touch events.
 *
 * @param {Array} points — array of {x, y, delay} from generateHumanSwipePath
 */
async function sendTouchSwipe(points) {
  if (points.length === 0) return;

  const startPt = points[0];

  // touchStart — finger touches the screen
  await cdpSend('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: startPt.x, y: startPt.y }]
  });

  // touchMoved — finger slides across the screen
  for (let i = 1; i < points.length - 1; i++) {
    const pt = points[i];
    // Scale delay for faster execution (we don't need real-time accuracy)
    const scaledDelay = Math.min(pt.delay, 40); // cap at 40ms per step
    if (scaledDelay > 2) await sleep(scaledDelay * 0.7);

    await cdpSend('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: pt.x, y: pt.y }]
    });
  }

  // touchEnd — finger lifts off
  await cdpSend('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: []
  });
}

/**
 * Send mouse events for a swipe path via CDP.
 * Used for desktop sites that listen to mouse drag events.
 *
 * @param {Array} points — array of {x, y, delay} from generateHumanSwipePath
 */
async function sendMouseSwipe(points) {
  if (points.length === 0) return;

  const startPt = points[0];
  const endPt = points[points.length - 1];

  // mouseMoved to start position
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: startPt.x, y: startPt.y
  });
  await sleep(20);

  // mousePressed — press and hold left button
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mousePressed', x: startPt.x, y: startPt.y,
    button: 'left', clickCount: 1
  });

  // mouseMoved — drag the mouse along the path
  for (let i = 1; i < points.length - 1; i++) {
    const pt = points[i];
    const scaledDelay = Math.min(pt.delay, 40);
    if (scaledDelay > 2) await sleep(scaledDelay * 0.7);

    await cdpSend('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: pt.x, y: pt.y,
      button: 'left'
    });
  }

  // mouseMoved to final position
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseMoved', x: endPt.x, y: endPt.y,
    button: 'left'
  });

  // mouseReleased — release the button
  await cdpSend('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x: endPt.x, y: endPt.y,
    button: 'left', clickCount: 1
  });
}

/**
 * Swipe at normalized coordinates in a direction.
 * Simulates a human-like finger drag (touch + mouse events) for carousels,
 * sliders, swipe-to-action, and mobile web apps.
 *
 * Humanization features:
 *   - Bezier curve trajectory (not perfectly straight)
 *   - Phase-based speed: acceleration → constant → deceleration → inertia
 *   - Micro-tremor jitter (±1–3px per step)
 *   - Occasional micro-pauses (10–35ms hesitations)
 *   - Sinusoidal speed modulation (simulates muscle micro-adjustments)
 *
 * @param {number} nx — normalized X start position (0–1000)
 * @param {number} ny — normalized Y start position (0–1000)
 * @param {string} direction — 'left' | 'right' | 'up' | 'down'
 * @param {number} [distance] — swipe distance in pixels (default: 300)
 * @param {number} [duration] — swipe duration in ms (default: auto 250–450)
 * @param {Object} [humanize] — humanization parameters
 * @param {number} [humanize.jitter] — jitter amount in px (default: 1.5–3)
 * @param {number} [humanize.curvature] — trajectory curvature (default: auto)
 * @param {number} [humanize.microPauseChance] — pause probability 0–1 (default: 0.08)
 * @param {boolean} [humanize.inertia] — add release slide (default: true)
 */
export async function toolSwipe(nx, ny, direction = 'left', distance = 300, duration, humanize = {}) {
  const viewport = await getViewportSize();
  const { x: startX, y: startY } = normalizeCoords(nx, ny, viewport);

  // Calculate end coordinates based on direction
  const endX = direction === 'left'  ? startX - distance :
               direction === 'right' ? startX + distance : startX;
  const endY = direction === 'up'    ? startY - distance :
               direction === 'down'  ? startY + distance : startY;

  // Clamp to viewport bounds
  const clampedEndX = Math.max(10, Math.min(viewport.width - 10, endX));
  const clampedEndY = Math.max(10, Math.min(viewport.height - 10, endY));

  try {
    // Focus agent tab
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // Snapshot tab IDs before swipe (in case swipe triggers navigation)
    const tabIdsBefore = await snapshotTabIds();

    // Generate human-like swipe path
    const points = generateHumanSwipePath(startX, startY, clampedEndX, clampedEndY, {
      durationMs: duration,
      jitter: humanize.jitter,
      curvature: humanize.curvature,
      microPauseChance: humanize.microPauseChance
    });

    broadcast({
      kind: 'log',
      text: `👆 Swipe ${direction}: (${startX},${startY}) → (${clampedEndX},${clampedEndY}), ${points.length} steps, humanized`
    });

    // Send both touch AND mouse events (covers mobile + desktop)
    await sendTouchSwipe(points);
    await sleep(50); // brief pause between touch and mouse
    await sendMouseSwipe(points);

    // Post-swipe: park mouse at end position (Anti-Blink)
    runtime._mouseParkCoords = { x: clampedEndX, y: clampedEndY };
    await sleep(100);

    // Detect if swipe triggered navigation or new tab
    await sleep(300);
    const newTab = await detectNewTab(tabIdsBefore);

    const result = {
      ok: true,
      tool: 'swipe',
      direction,
      distance,
      from: { x: startX, y: startY },
      to: { x: clampedEndX, y: clampedEndY },
      normalized: { fromX: nx, fromY: ny },
      steps: points.length,
      humanized: true
    };

    if (newTab) {
      result.newTabOpened = true;
      result.newTabId = newTab.id;
      result.newTabUrl = (newTab.url || '').slice(0, 200);
      result.previousTabId = runtime.agentTabId;
    }

    return result;
  } catch (e) {
    return { ok: false, tool: 'swipe', error: e.message, direction };
  }
}

// ============================================================
// COORDINATE NORMALIZATION
// ============================================================

/**
 * The AI model returns coordinates in a normalized 0–1000 space.
 * We need to scale them to actual viewport pixel coordinates.
 *
 * Screenshot dimensions (what the model sees) may differ from
 * the CDP viewport (what receives events). We handle DPR scaling too.
 *
 * @param {number} nx — normalized X (0–1000)
 * @param {number} ny — normalized Y (0–1000)
 * @param {{ width: number, height: number }} viewport — actual viewport size
 * @returns {{ x: number, y: number }}
 */
export function normalizeCoords(nx, ny, viewport) {
  const w = viewport?.width || 1280;
  const h = viewport?.height || 800;
  const x = Math.round((nx / 1000) * w);
  const y = Math.round((ny / 1000) * h);
  return {
    x: Math.max(0, Math.min(w - 1, x)),
    y: Math.max(0, Math.min(h - 1, y))
  };
}

/**
 * Get the current viewport dimensions.
 * Uses CDP Browser.getWindowForTarget or falls back to settings.
 */
export async function getViewportSize() {
  try {
    // Try CDP first — most accurate
    if (runtime.cdpAttached && runtime.cdpTarget) {
      const result = await cdpSend('Runtime.evaluate', {
        expression: 'JSON.stringify({width: window.innerWidth, height: window.innerHeight})',
        returnByValue: true
      });
      if (result?.result?.value) {
        const parsed = JSON.parse(result.result.value);
        return { width: parsed.width, height: parsed.height };
      }
    }
  } catch (_) {}

  // Fallback to settings
  try {
    const settings = await getSettings();
    return {
      width: settings.agent_viewport_width || 1280,
      height: settings.agent_viewport_height || 800
    };
  } catch (_) {}  return { width: 1280, height: 800 };
}

// ============================================================
// SELECT DETECTION (read-only DOM probe at click coordinates)
// ============================================================
/**
 * Detect whether a native <select> element exists at the given viewport pixel coordinates.
 * Uses document.elementFromPoint — a single read-only DOM probe, no side effects.
 * Returns { isSelect: false } if no <select> is found, or full option data otherwise.
 * Safe: silently returns { isSelect: false } on any CDP error or 500 ms timeout.
 *
 * @param {number} x — viewport X in pixels (already normalized)
 * @param {number} y — viewport Y in pixels (already normalized)
 * @returns {Promise<Object>}
 */
async function detectSelectAtPoint(x, y) {
  const script = `(function() {
  var el = document.elementFromPoint(${x}, ${y});
  if (!el || el.tagName !== 'SELECT') return { isSelect: false };
  if (el.disabled) return { isSelect: true, disabled: true };
  var opts = Array.from(el.options);
  var options = opts.slice(0, 50).map(function(o, i) {
    return { index: i, value: o.value, text: o.textContent.trim().slice(0, 80), selected: o.selected };
  });
  var result = {
    isSelect: true,
    disabled: false,
    currentValue: el.value,
    currentText: el.options[el.selectedIndex] ? el.options[el.selectedIndex].textContent.trim() : '',
    options: options
  };
  if (opts.length > 50) { result.truncated = true; result.totalOptions = opts.length; }
  return result;
})()`;

  try {
    const result = await Promise.race([
      cdpSend('Runtime.evaluate', { expression: script, returnByValue: true }),
      new Promise(resolve => setTimeout(() => resolve(null), 500))
    ]);

    if (result?.result?.value && typeof result.result.value === 'object' && 'isSelect' in result.result.value) {
      return result.result.value;
    }
  } catch (_) {}

  return { isSelect: false };
}

// ============================================================
// NEW TAB DETECTION (target="_blank" monitoring)
// ============================================================

/**
 * Snapshot the set of all tab IDs in the current window.
 * Used before a click to detect if the click opened a new tab.
 *
 * @returns {Promise<Set<number>>} set of tab IDs
 */
export async function snapshotTabIds() {
  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return new Set(tabs.map(t => t.id));
  } catch (_) {
    return new Set();
  }
}

/**
 * Compare current tabs against a pre-click snapshot to find a newly opened tab.
 * Only returns tabs whose `openerTabId` matches the agent's active tab —
 * this filters out tabs opened by the user or other extensions.
 *
 * @param {Set<number>} beforeTabIds — snapshot from before the click
 * @param {number} maxAgeMs — maximum age of the new tab in ms (default 3000)
 * @returns {Promise<chrome.tabs.Tab|null>} the new tab, or null if none found
 */
export async function detectNewTab(beforeTabIds, maxAgeMs = 3000) {
  if (!beforeTabIds || beforeTabIds.size === 0) return null;

  try {
    const tabs = await chrome.tabs.query({ currentWindow: true });

    for (const tab of tabs) {
      // Skip tabs that existed before the click
      if (beforeTabIds.has(tab.id)) continue;

      // Only consider tabs opened by the agent's own tab
      if (tab.openerTabId !== runtime.agentTabId) continue;

      // Sanity check: tab should be reasonably fresh
      // (some browsers don't expose tab creation time, so this is best-effort)
      return tab;
    }

    // Fallback: if openerTabId is not available (some Chrome versions),
    // look for the single newest tab that wasn't in our snapshot
    const newTabs = tabs.filter(t => !beforeTabIds.has(t.id));
    if (newTabs.length === 1) {
      return newTabs[0];
    }
  } catch (_) {}

  return null;
}

// ============================================================
// VISION TOOLS — each returns { ok, ... } observation
// ============================================================

/**
 * Click at normalized coordinates.
 * Always uses CDP for trusted events (isTrusted: true).
 *
 * Special case: if a native <select> is detected at the click point, the physical
 * click is skipped (native popup is invisible to CDP screenshots) and the full
 * list of options is returned as text in the observation.
 */
export async function toolClickAt(nx, ny, clickCount = 1) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    // Focus agent tab so CDP events reach the page
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // --- Select detection (read-only DOM probe, ≤500 ms) ---
    const detected = await detectSelectAtPoint(x, y);

    if (detected.isSelect) {
      // Disabled select → reject the click
      if (detected.disabled) {
        return {
          ok: false, tool: 'click_at', error: 'select_disabled',
          normalized: { x: nx, y: ny }, actual: { x, y }
        };
      }

      // Enabled select → return options as text, skip physical click
      const observation = {
        ok: true,
        tool: 'click_at',
        detected: 'select',
        currentValue: detected.currentValue,
        currentText: detected.currentText,
        options: detected.options,
        hint: 'Это select-поле. Чтобы выбрать значение, используйте select_at(x, y, value) с точным value или текстом опции из списка выше.'
      };
      if (detected.truncated) {
        observation.truncated = true;
        observation.totalOptions = detected.totalOptions;
      }
      return observation;
    }

    // --- Normal click (not a <select>) ---
    // Snapshot current tab IDs before clicking (for new tab detection)
    const tabIdsBefore = await snapshotTabIds();

    for (let i = 0; i < clickCount; i++) {
      await cdpClick(x, y);
      if (i < clickCount - 1) await sleep(100);
    }

    // --- Detect if a new tab was opened by the click (target="_blank") ---
    // Wait a brief moment for the new tab to be created
    await sleep(500);
    const newTab = await detectNewTab(tabIdsBefore);

    const observation = {
      ok: true, tool: 'click_at',
      normalized: { x: nx, y: ny }, actual: { x, y }, clickCount
    };

    if (newTab) {
      observation.newTabOpened = true;
      observation.newTabId = newTab.id;
      observation.newTabUrl = (newTab.url || '').slice(0, 200);
      observation.newTabTitle = (newTab.title || '').slice(0, 100);
      observation.previousTabId = runtime.agentTabId;
      observation.hint = 'Новая вкладка открылась кликом. Если хотите её посмотреть — switch_tab(newTabId). Если хотите остаться здесь — игнорируйте. Чтобы закрыть ненужную вкладку — close_tab(newTabId).';
    }

    return observation;
  } catch (e) {
    return { ok: false, tool: 'click_at', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Right-click at normalized coordinates.
 * Opens the browser's context menu (or the page's custom JS context menu).
 * Always uses CDP for trusted events (isTrusted: true).
 *
 * IMPORTANT: Native browser context menus are NOT visible in CDP screenshots.
 * Custom JS-based context menus (most modern web apps) ARE visible.
 * After the right-click, the agent should:
 *   1. wait(1) to let the menu appear
 *   2. Take a screenshot (happens automatically on next step)
 *   3. If a custom context menu is visible — click_at the desired item
 *   4. If no menu is visible (native menu) — press_key("Escape") to dismiss
 *
 * @param {number} nx — normalized X (0–1000)
 * @param {number} ny — normalized Y (0–1000)
 */
export async function toolRightClickAt(nx, ny) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    await cdpRightClick(x, y);

    return {
      ok: true, tool: 'right_click_at',
      normalized: { x: nx, y: ny }, actual: { x, y },
      hint: 'Контекстное меню вызвано. Нативное меню браузера НЕ видно на скриншотах — если ничего не появилось, это оно. Кастомное JS-меню сайта будет видно. Для взаимодействия: click_at на пункт меню или press_key("Escape") для закрытия.'
    };
  } catch (e) {
    return { ok: false, tool: 'right_click_at', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Type text at normalized coordinates.
 * Click to focus → Clear field (Ctrl+A, Delete) → Insert text.
 * Handles any Unicode: Cyrillic, CJK, emoji, etc.
 *
 * AUTO-FALLBACK: After CDP insertText, verifies the text was actually
 * inserted by reading the active element's value. If verification fails
 * (e.g. CodeMirror/Monaco ignores insertText), automatically retries
 * via toolTypeCode which tries editor API → clipboard paste → execCommand.
 */
export async function toolTypeAt(nx, ny, text, clearFirst = true) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // Click to focus the input field
    await cdpClick(x, y);
    await sleep(100);

    if (clearFirst) {
      // Select all (Ctrl+A)
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        modifiers: 2 // Ctrl
      });
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'a', code: 'KeyA',
        windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
        modifiers: 2
      });
      await sleep(50);

      // Delete selected text
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Delete', code: 'Delete',
        windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
      });
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Delete', code: 'Delete',
        windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
      });
      await sleep(50);
    }

    // Type text using Input.insertText (handles all Unicode)
    await cdpType(text || '');

    // VERIFICATION: Check if text was actually inserted
    // CodeMirror/Monaco/Ace ignore Input.insertText — text won't appear
    await sleep(150);
    try {
      const verifyResult = await cdpSend('Runtime.evaluate', {
        expression: `(function() {
          var el = document.activeElement;
          if (!el) return 'no_active_element';
          // Check standard inputs and textareas
          if (el.value !== undefined && el.tagName !== 'SELECT') {
            return el.value.length > 0 ? 'ok' : 'empty';
          }
          // Check contenteditable (CodeMirror, etc.)
          if (el.isContentEditable) {
            return el.textContent.length > 0 ? 'ok' : 'empty';
          }
          // Check CodeMirror 6 specifically
          var cm = el.closest && (el.closest('.cm-editor') || el.closest('.cm-content'));
          if (cm) return 'codemirror_needs_api';
          return 'unknown_type';
        })()`,
        returnByValue: true
      });

      const status = verifyResult?.result?.value;

      // If we detected a code editor or text didn't appear, auto-fallback
      if (status === 'codemirror_needs_api' || status === 'empty') {
        broadcast({ kind: 'log', text: `⌨️ type_at verification: ${status} — auto-fallback to type_code` });
        return await toolTypeCode(nx, ny, text || '');
      }
    } catch (_) {
      // Verification failed — that's OK, assume insertText worked
    }

    return { ok: true, tool: 'type_at', normalized: { x: nx, y: ny }, length: (text || '').length, cleared: clearFirst };
  } catch (e) {
    // If insertText threw, try type_code as last resort
    broadcast({ kind: 'log', text: `⌨️ type_at failed (${e.message}), trying type_code fallback...` });
    try {
      return await toolTypeCode(nx, ny, text || '');
    } catch (e2) {
      return { ok: false, tool: 'type_at', error: e2.message, normalized: { x: nx, y: ny } };
    }
  }
}

/**
 * Paste text at normalized coordinates via clipboard (Ctrl+V).
 * Click to focus → Write text to clipboard → Paste via Ctrl+V.
 *
 * Unlike type_at (which uses Input.insertText), this tool writes the text
 * to the system clipboard via navigator.clipboard.writeText and then
 * dispatches a real Ctrl+V keypress. This triggers paste event handlers
 * on web pages (e.g. React controlled inputs, code editors) that don't
 * fire for insertText.
 *
 * Use case: fields where type_at doesn't work because the page listens
 * to paste/clipboard events specifically, or for rich-text editors that
 * parse pasted HTML/content differently from typed input.
 *
 * @param {number} nx — normalized X (0–1000)
 * @param {number} ny — normalized Y (0–1000)
 * @param {string} text — text to paste
 */
export async function toolPasteText(nx, ny, text) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);
  const safeText = text || '';

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // 1. Click on the target element to focus it
    await cdpClick(x, y);
    await sleep(100);

    // 2. Write text to the system clipboard via CDP Runtime.evaluate
    //    NOTE: navigator.clipboard.writeText requires user activation,
    //    which may not be available in CDP context. We wrap it in try/catch
    //    and fall back to document.execCommand if it fails.
    const escapedText = JSON.stringify(safeText);
    let clipboardWritten = false;

    try {
      await cdpSend('Runtime.evaluate', {
        expression: `navigator.clipboard.writeText(${escapedText})`,
        awaitPromise: true
      });
      clipboardWritten = true;
    } catch (_) {
      // Clipboard API not available in CDP context — that's OK, try fallback
    }

    if (clipboardWritten) {
      await sleep(50);

      // 3. Dispatch Ctrl+V (trusted paste event)
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'v', code: 'KeyV',
        windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
        modifiers: 2 // Ctrl
      });
      await cdpSend('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'v', code: 'KeyV',
        windowsVirtualKeyCode: 86, nativeVirtualKeyCode: 86,
        modifiers: 2
      });

      return { ok: true, tool: 'paste_text', normalized: { x: nx, y: ny }, length: safeText.length };
    }

    // FALLBACK: clipboard API failed — use document.execCommand('insertText')
    // This works in contenteditable elements and some rich text editors
    const execResult = await cdpSend('Runtime.evaluate', {
      expression: `(function() {
        var el = document.activeElement || document.elementFromPoint(${x}, ${y});
        if (!el) return false;
        el.focus();
        document.execCommand('selectAll', false, null);
        return document.execCommand('insertText', false, ${escapedText});
      })()`,
      returnByValue: true
    });

    if (execResult?.result?.value === true) {
      return { ok: true, tool: 'paste_text', method: 'execCommand_fallback', normalized: { x: nx, y: ny }, length: safeText.length };
    }

    return { ok: false, tool: 'paste_text', error: 'clipboard_and_execCommand_failed', normalized: { x: nx, y: ny } };
  } catch (e) {
    return { ok: false, tool: 'paste_text', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Press a keyboard key.
 */
export async function toolPressKey(key) {
  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
    await cdpPressKey(key);
    return { ok: true, tool: 'press_key', key };
  } catch (e) {
    return { ok: false, tool: 'press_key', error: e.message, key };
  }
}

/**
 * Scroll at normalized coordinates in a direction.
 * Uses CDP mouseWheel which is the most reliable scroll method.
 */
export async function toolScroll(direction, amount = 300, nx = 500, ny = 500) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  const deltaY = direction === 'up' ? -Math.abs(amount) :
                 direction === 'down' ? Math.abs(amount) :
                 direction === 'top' ? -10000 :
                 direction === 'bottom' ? 10000 : 0;

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    if (direction === 'top') {
      await cdpSend('Runtime.evaluate', { expression: 'window.scrollTo(0, 0)' });
    } else if (direction === 'bottom') {
      await cdpSend('Runtime.evaluate', { expression: 'window.scrollTo(0, document.documentElement.scrollHeight)' });
    } else {
      await cdpSend('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x, y,
        deltaX: 0, deltaY
      });
    }

    return { ok: true, tool: 'scroll', direction, amount, normalized: { x: nx, y: ny } };
  } catch (e) {
    return { ok: false, tool: 'scroll', error: e.message, direction };
  }
}

/**
 * Hover at normalized coordinates.
 * Triggers :hover CSS, reveals dropdown menus, tooltips, etc.
 */
export async function toolHoverAt(nx, ny) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    await cdpHover(x, y);
    return { ok: true, tool: 'hover_at', normalized: { x: nx, y: ny }, actual: { x, y } };
  } catch (e) {
    return { ok: false, tool: 'hover_at', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Select a dropdown option at normalized coordinates.
 * Clicks on the select element to focus it, then sets the value via DOM.
 *
 * Uses document.elementFromPoint to reliably locate the <select> at the
 * click coordinates (falls back to document.activeElement if needed).
 * For custom dropdowns (div-based), the AI should click_at the visible option.
 */
export async function toolSelectAt(nx, ny, value) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // Click on the select element to focus it
    await cdpClick(x, y);
    await sleep(200);

    // Use elementFromPoint to find the select at coordinates (more reliable than activeElement alone)
    const escapedValue = JSON.stringify(value);
    const script = `
      (function() {
        var el = document.elementFromPoint(${x}, ${y});
        if (!el || el.tagName !== 'SELECT') {
          el = document.activeElement;
          if (!el || el.tagName !== 'SELECT') return { ok: false, error: 'not_a_select' };
        }
        var val = ${escapedValue};
        var option = Array.from(el.options).find(function(o) {
          return o.value === val || o.textContent.trim() === val;
        });
        if (!option) {
          var partial = Array.from(el.options).find(function(o) {
            return o.value.indexOf(val) !== -1 || o.textContent.trim().indexOf(val) !== -1;
          });
          if (!partial) return { ok: false, error: 'option_not_found', available: Array.from(el.options).slice(0, 10).map(function(o) { return { value: o.value, text: o.textContent.trim() }; }) };
          el.value = partial.value;
        } else {
          el.value = option.value;
        }
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return { ok: true, selected: el.value };
      })()
    `;

    const result = await cdpSend('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });

    const selectResult = result?.result?.value;
    if (selectResult?.ok) {
      return { ok: true, tool: 'select_at', normalized: { x: nx, y: ny }, selected: selectResult.selected };
    }

    return { ok: false, tool: 'select_at', error: selectResult?.error || 'select_failed', value };
  } catch (e) {
    return { ok: false, tool: 'select_at', error: e.message, normalized: { x: nx, y: ny }, value };
  }
}

/**
 * Set value in a code editor via its native API (CodeMirror, Monaco, Ace, etc.)
 * Falls back to clipboard paste if no editor API is detected.
 *
 * This is the most reliable way to insert code into code editors that
 * ignore Input.insertText (CodeMirror, Monaco, Ace, etc.)
 *
 * @param {number} nx — normalized X (0–1000)
 * @param {number} ny — normalized Y (0–1000)
 * @param {string} text — text to set
 * @returns {Promise<Object>} observation
 */
export async function toolSetValueViaApi(nx, ny, text) {
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);

  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}

    // Click to focus the editor first
    await cdpClick(x, y);
    await sleep(200);

    // Multi-strategy script: tries all known editor APIs
    const escapedText = JSON.stringify(text || '');
    const script = `(function() {
      var el = document.elementFromPoint(${x}, ${y});
      if (!el) return { ok: false, error: 'no_element_at_point' };

      // Strategy 1: CodeMirror 6 (used by Colab, modern editors)
      // Walk up the DOM to find the .cm-editor container
      var cmEl = el.closest('.cm-editor') || el.closest('.cm-content');
      if (!cmEl) {
        // Also check if element IS inside a CodeMirror editor by parent traversal
        var p = el;
        for (var i = 0; i < 15 && p; i++) {
          if (p.classList && (p.classList.contains('cm-editor') || p.classList.contains('cm-content'))) {
            cmEl = p.closest('.cm-editor') || p;
            break;
          }
          p = p.parentElement;
        }
      }
      if (cmEl) {
        // CodeMirror 6: access the EditorView via internal reference
        // CM6 stores the view on the DOM element as cmView
        var cmView = cmEl.cmView;
        if (!cmView) {
          // Try alternative access: CM6 stores view in a WeakMap or via dom.cmView
          // Walk up to find it
          var walker = cmEl;
          for (var j = 0; j < 5 && walker; j++) {
            if (walker.cmView) { cmView = walker.cmView; break; }
            walker = walker.parentElement;
          }
        }
        if (cmView && cmView.view) {
          var view = cmView.view;
          var newCode = ${escapedText};
          view.dispatch({
            changes: { from: 0, to: view.state.doc.length, insert: newCode }
          });
          return { ok: true, editor: 'codemirror6', length: newCode.length };
        }

        // CodeMirror 5 fallback (Colab older versions)
        var cm5Wrap = el.closest('.CodeMirror') || (cmEl.closest && cmEl.closest('.CodeMirror'));
        if (cm5Wrap && cm5Wrap.CodeMirror) {
          var cm5 = cm5Wrap.CodeMirror;
          cm5.setValue(${escapedText});
          cm5.refresh();
          return { ok: true, editor: 'codemirror5', length: (${escapedText}).length };
        }
      }

      // Strategy 2: CodeMirror 5 (direct, without CM6 detection)
      var cm5El = el.closest('.CodeMirror');
      if (!cm5El) {
        var p2 = el;
        for (var k = 0; k < 15 && p2; k++) {
          if (p2.classList && p2.classList.contains('CodeMirror')) { cm5El = p2; break; }
          p2 = p2.parentElement;
        }
      }
      if (cm5El && cm5El.CodeMirror) {
        cm5El.CodeMirror.setValue(${escapedText});
        cm5El.CodeMirror.refresh();
        return { ok: true, editor: 'codemirror5', length: (${escapedText}).length };
      }

      // Strategy 3: Monaco Editor (VS Code web, Monaco-based editors)
      if (typeof monaco !== 'undefined' && monaco.editor) {
        var editors = monaco.editor.getEditors();
        for (var m = 0; m < editors.length; m++) {
          try {
            var domNode = editors[m].getDomNode();
            if (!domNode) continue;
            var rect = domNode.getBoundingClientRect();
            // Check if click coordinates fall within this editor
            if (${x} >= rect.left && ${x} <= rect.right && ${y} >= rect.top && ${y} <= rect.bottom) {
              var model = editors[m].getModel();
              if (model) {
                editors[m].executeEdits('webclaw', [{
                  range: model.getFullModelRange(),
                  text: ${escapedText}
                }]);
                return { ok: true, editor: 'monaco', length: (${escapedText}).length };
              }
            }
          } catch (_) {}
        }
        // Fallback: if only one Monaco editor exists, use it
        if (editors.length === 1 && editors[0].getModel()) {
          var e = editors[0];
          var m2 = e.getModel();
          e.executeEdits('webclaw', [{ range: m2.getFullModelRange(), text: ${escapedText} }]);
          return { ok: true, editor: 'monaco_single', length: (${escapedText}).length };
        }
      }

      // Strategy 4: Ace Editor (used by Jupyter, older notebooks)
      var aceEl = el.closest('.ace_editor');
      if (!aceEl) {
        var p3 = el;
        for (var n = 0; n < 15 && p3; n++) {
          if (p3.classList && p3.classList.contains('ace_editor')) { aceEl = p3; break; }
          p3 = p3.parentElement;
        }
      }
      if (aceEl && aceEl.env && aceEl.env.editor) {
        aceEl.env.editor.setValue(${escapedText}, -1);
        return { ok: true, editor: 'ace', length: (${escapedText}).length };
      }

      // Strategy 5: Check for any .ace_editor globally (Jupyter cells)
      var aceEditors = document.querySelectorAll('.ace_editor');
      if (aceEditors.length > 0) {
        // Find the closest one to click coordinates
        var closest = null;
        var minDist = Infinity;
        for (var a = 0; a < aceEditors.length; a++) {
          var r = aceEditors[a].getBoundingClientRect();
          var cx = (r.left + r.right) / 2;
          var cy = (r.top + r.bottom) / 2;
          var dist = Math.sqrt(Math.pow(${x} - cx, 2) + Math.pow(${y} - cy, 2));
          if (dist < minDist) { minDist = dist; closest = aceEditors[a]; }
        }
        if (closest && closest.env && closest.env.editor && minDist < 500) {
          closest.env.editor.setValue(${escapedText}, -1);
          return { ok: true, editor: 'ace_nearest', length: (${escapedText}).length };
        }
      }

      // Strategy 6: textarea / input — direct DOM value setting
      var textarea = el.tagName === 'TEXTAREA' ? el : el.closest('textarea') || el.querySelector('textarea');
      if (!textarea) {
        var p4 = el;
        for (var q = 0; q < 10 && p4; q++) {
          if (p4.tagName === 'TEXTAREA') { textarea = p4; break; }
          p4 = p4.parentElement;
        }
      }
      if (textarea) {
        var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
        nativeSetter.call(textarea, ${escapedText});
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, editor: 'textarea', length: (${escapedText}).length };
      }

      // Strategy 7: contenteditable — set innerHTML/innerText
      if (el.isContentEditable || el.contentEditable === 'true') {
        el.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, ${escapedText});
        return { ok: true, editor: 'contenteditable', length: (${escapedText}).length };
      }

      return { ok: false, error: 'no_editor_detected', element: el.tagName + '.' + (el.className || '').toString().slice(0, 100) };
    })()`;

    const result = await cdpSend('Runtime.evaluate', {
      expression: script,
      returnByValue: true
    });

    const val = result?.result?.value;
    if (val?.ok) {
      broadcast({ kind: 'log', text: `📝 Editor API: ${val.editor} — ${val.length} chars set` });
      return { ok: true, tool: 'set_value_via_api', ...val, normalized: { x: nx, y: ny } };
    }

    return { ok: false, tool: 'set_value_via_api', error: val?.error || 'api_failed', normalized: { x: nx, y: ny } };
  } catch (e) {
    return { ok: false, tool: 'set_value_via_api', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Smart code insertion — auto-detects the editor type and uses the best method.
 *
 * Fallback chain:
 *   1. Try editor native API (CodeMirror 5/6, Monaco, Ace)
 *   2. Try clipboard paste (Ctrl+V)
 *   3. Try document.execCommand('insertText')
 *   4. Try Input.insertText (CDP)
 *
 * This is the recommended tool for inserting code/multiline text into
 * any text field, especially code editors in Colab, Jupyter, Replit, etc.
 *
 * @param {number} nx — normalized X (0–1000)
 * @param {number} ny — normalized Y (0–1000)
 * @param {string} text — text to insert
 * @returns {Promise<Object>} observation
 */
export async function toolTypeCode(nx, ny, text) {
  if (!text) return { ok: false, tool: 'type_code', error: 'no_text' };

  broadcast({ kind: 'log', text: `⌨️ type_code: ${text.length} chars at (${nx},${ny})` });

  // Step 1: Try editor API first (most reliable for code editors)
  const apiResult = await toolSetValueViaApi(nx, ny, text);
  if (apiResult.ok) {
    return { ...apiResult, tool: 'type_code', method: 'editor_api' };
  }

  broadcast({ kind: 'log', text: `⌨️ Editor API failed (${apiResult.error}), trying paste...` });

  // Step 2: Try clipboard paste
  const pasteResult = await toolPasteText(nx, ny, text);
  if (pasteResult.ok) {
    return { ...pasteResult, tool: 'type_code', method: 'clipboard_paste' };
  }

  broadcast({ kind: 'log', text: `⌨️ Clipboard paste failed (${pasteResult.error}), trying execCommand...` });

  // Step 3: Try document.execCommand('insertText') — works in some contenteditable
  const viewport = await getViewportSize();
  const { x, y } = normalizeCoords(nx, ny, viewport);
  try {
    try { await chrome.tabs.update(runtime.agentTabId, { active: true }); } catch (_) {}
    await cdpClick(x, y);
    await sleep(100);

    // Select all first
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await sleep(50);

    const escapedText = JSON.stringify(text);
    const execResult = await cdpSend('Runtime.evaluate', {
      expression: `(function() {
        var el = document.activeElement;
        if (!el) return false;
        document.execCommand('selectAll', false, null);
        return document.execCommand('insertText', false, ${escapedText});
      })()`,
      returnByValue: true
    });

    if (execResult?.result?.value === true) {
      // Verify text was actually inserted
      await sleep(100);
      const verifyResult = await cdpSend('Runtime.evaluate', {
        expression: `(function() {
          var el = document.activeElement;
          if (!el) return false;
          var current = el.value || el.innerText || '';
          return current.length > 0;
        })()`,
        returnByValue: true
      });
      if (verifyResult?.result?.value === true) {
        return { ok: true, tool: 'type_code', method: 'execCommand', normalized: { x: nx, y: ny }, length: text.length };
      }
    }
  } catch (_) {}

  broadcast({ kind: 'log', text: `⌨️ execCommand failed, trying Input.insertText (last resort)...` });

  // Step 4: Last resort — CDP Input.insertText
  try {
    await cdpClick(x, y);
    await sleep(100);
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA',
      windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65,
      modifiers: 2
    });
    await sleep(50);
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Delete', code: 'Delete',
      windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
    });
    await cdpSend('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Delete', code: 'Delete',
      windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46
    });
    await sleep(50);
    await cdpType(text);
    return { ok: true, tool: 'type_code', method: 'insertText', normalized: { x: nx, y: ny }, length: text.length };
  } catch (e) {
    return { ok: false, tool: 'type_code', error: e.message, normalized: { x: nx, y: ny } };
  }
}

/**
 * Toggle a checkbox or radio button at normalized coordinates.
 * Simply clicks at the coordinates — the browser handles toggle state.
 */
export async function toolCheckboxAt(nx, ny) {
  // A checkbox toggle is just a click
  const result = await toolClickAt(nx, ny);
  return { ...result, tool: 'checkbox_at' };
}

/**
 * Navigate to a URL.
 */
export async function toolNavigate(url) {
  if (!url) return { ok: false, tool: 'navigate', error: 'no_url' };

  try {
    await chrome.tabs.update(runtime.agentTabId, { url });

    // Wait for navigation
    const start = Date.now();
    while (Date.now() - start < 10000) {
      await sleep(300);
      try {
        const tab = await chrome.tabs.get(runtime.agentTabId);
        if (tab?.url && tab.url !== 'about:blank') break;
      } catch (_) {}
    }

    // Wait for page readiness
    try { await waitPageReady(); } catch (_) {}
    return { ok: true, tool: 'navigate', url };
  } catch (e) {
    return { ok: false, tool: 'navigate', error: e.message, url };
  }
}

/**
 * Go back in browser history.
 */
export async function toolBack() {
  try {
    await chrome.tabs.goBack(runtime.agentTabId);
    await sleep(1000);
    try { await waitPageReady(); } catch (_) {}
    return { ok: true, tool: 'back' };
  } catch (e) {
    return { ok: false, tool: 'back', error: e.message };
  }
}

/**
 * Switch to another browser tab by ID.
 * Detaches CDP from the current tab, updates agentTabId,
 * attaches CDP to the target tab, and waits for page readiness.
 *
 * Used after target="_blank" links open a new tab — the agent
 * can switch to inspect it, then switch back if it's not useful.
 *
 * @param {number} tabId — Chrome tab ID to switch to
 */
export async function toolSwitchTab(tabId) {
  if (!tabId) return { ok: false, tool: 'switch_tab', error: 'no_tab_id' };

  try {
    // Verify the target tab exists
    const tab = await chrome.tabs.get(tabId);
    if (!tab) return { ok: false, tool: 'switch_tab', error: 'tab_not_found', tabId };

    const previousTabId = runtime.agentTabId;

    // Skip if already on this tab
    if (previousTabId === tabId) {
      return { ok: true, tool: 'switch_tab', alreadyThere: true, tabId, url: tab.url };
    }

    // Detach CDP from current tab (safe — no-op if not attached)
    if (runtime.cdpAttached) {
      await cdpDetach();
    }

    // Update agent tab reference
    runtime.agentTabId = tabId;

    // Attach CDP to the new tab
    await cdpAttach(tabId);

    // Focus the new tab
    try { await chrome.tabs.update(tabId, { active: true }); } catch (_) {}

    // Wait for page readiness
    await sleep(1000);
    try { await waitPageReady(); } catch (_) {}

    broadcast({ kind: 'log', text: `🔀 Switched to tab ${tabId}: ${(tab.url || '').slice(0, 80)}` });

    return {
      ok: true, tool: 'switch_tab',
      previousTabId,
      newTabId: tabId,
      url: (tab.url || '').slice(0, 200),
      title: (tab.title || '').slice(0, 100)
    };
  } catch (e) {
    return { ok: false, tool: 'switch_tab', error: e.message, tabId };
  }
}

/**
 * Close a browser tab by ID.
 * If the closed tab is the current agent tab, returns an error —
 * the agent must switch to another tab first.
 *
 * Used to clean up target="_blank" tabs that turned out to be useless.
 *
 * @param {number} tabId — Chrome tab ID to close
 */
export async function toolCloseTab(tabId) {
  if (!tabId) return { ok: false, tool: 'close_tab', error: 'no_tab_id' };

  // Safety: don't allow closing the agent's own active tab
  if (tabId === runtime.agentTabId) {
    return { ok: false, tool: 'close_tab', error: 'cannot_close_active_tab', hint: 'Сначала переключитесь на другую вкладку через switch_tab, затем закройте эту.' };
  }

  try {
    await chrome.tabs.remove(tabId);
    broadcast({ kind: 'log', text: `🗑️ Closed tab ${tabId}` });
    return { ok: true, tool: 'close_tab', closedTabId: tabId };
  } catch (e) {
    return { ok: false, tool: 'close_tab', error: e.message, tabId };
  }
}

/**
 * Jump to a navigation tree node — "teleport" to a previously visited page.
 * Instead of clicking back() 10 times, the agent instantly navigates to the node's URL.
 *
 * @param {string} nodeId — target node ID (e.g., "nav_0", "nav_1.2")
 */
export async function toolJumpToNode(nodeId) {
  if (!nodeId) return { ok: false, tool: 'jump_to_node', error: 'no_node_id' };

  const memory = runtime._memory;
  if (!memory) return { ok: false, tool: 'jump_to_node', error: 'no_memory' };

  const result = memory.jumpToNavNode(nodeId);
  if (!result.ok) return { ok: false, tool: 'jump_to_node', error: result.error };

  // Navigate to the node's URL
  try {
    await chrome.tabs.update(runtime.agentTabId, { url: result.url });

    // Wait for navigation
    await sleep(2000);
    try { await waitPageReady(); } catch (_) {}

    broadcast({ kind: 'log', text: `🚀 Teleported to node [${nodeId}]: ${result.url.slice(0, 80)}` });
    return { ok: true, tool: 'jump_to_node', nodeId, url: result.url };
  } catch (e) {
    return { ok: false, tool: 'jump_to_node', error: e.message, nodeId };
  }
}

/**
 * Mark a navigation tree node with status and summary.
 * Used by the agent to annotate what it found on a page.
 *
 * @param {string} nodeId — target node ID (null = current node)
 * @param {string} status — 'explored' | 'promising' | 'dead_end'
 * @param {string} summary — brief note about findings
 */
export async function toolMarkNode(nodeId, status, summary) {
  const memory = runtime._memory;
  if (!memory) return { ok: false, tool: 'mark_node', error: 'no_memory' };

  const ok = memory.markNavNode(nodeId || null, status, summary);
  if (!ok) return { ok: false, tool: 'mark_node', error: `node_not_found: ${nodeId || 'current'}` };

  // Save to scratchpad if summary provided
  if (summary) {
    memory.addNote(`[${nodeId || memory.currentNodeId}] ${summary}`);
  }

  const targetId = nodeId || memory.currentNodeId;
  broadcast({ kind: 'log', text: `📌 Marked node [${targetId}] as "${status}": ${(summary || '').slice(0, 60)}` });

  // Broadcast nav tree update for UI
  broadcast({
    kind: 'nav_tree_changed',
    navTree: memory.toStatusPayload().navTree
  });

  return { ok: true, tool: 'mark_node', nodeId: targetId, status, summary };
}

// ============================================================
// SUBTASK STACK — call stack for multi-tab workflows
// ============================================================

/**
 * Open a new tab and enter a subtask — saves the current context
 * for guaranteed return via end_sub_task.
 *
 * The subtask runs in its own tab, with its own step budget.
 * The main task is paused but NOT forgotten — it's on the stack.
 *
 * @param {string} goal — what needs to be done in the subtask
 * @param {string} doneTrigger — how to know when it's complete
 * @param {string} [url] — URL to open (default: about:blank)
 * @param {number} [maxSteps] — step limit (default: 15, max: 30)
 * @returns {Promise<Object>} observation
 */
export async function toolSubTask(goal, doneTrigger, url, maxSteps) {
  const memory = runtime._memory;
  if (!memory) return { ok: false, tool: 'sub_task', error: 'no_memory' };

  if (!goal) return { ok: false, tool: 'sub_task', error: 'no_goal' };

  try {
    // Push subtask frame (saves current context: tabId, navNode)
    const frame = memory.pushSubtask({
      goal,
      doneTrigger: doneTrigger || '',
      maxSteps: maxSteps || 15,
      returnTabId: runtime.agentTabId,
      returnNavNodeId: memory.currentNodeId
    });

    // Save current URL for the frame
    try {
      const currentTab = await chrome.tabs.get(runtime.agentTabId);
      frame.returnUrl = currentTab?.url || '';
    } catch (_) {}

    // Open new tab for the subtask
    const newTab = await chrome.tabs.create({ url: url || 'about:blank', active: true });

    // Switch CDP to the new tab (reuses existing infrastructure)
    const switchResult = await toolSwitchTab(newTab.id);

    broadcast({ kind: 'log', text: `↘️ Вход в подзадачу: ${goal} (лимит: ${frame.maxSteps} шагов)` });

    return {
      ok: true,
      tool: 'sub_task',
      subtaskId: frame.id,
      goal: frame.goal,
      doneTrigger: frame.doneTrigger,
      maxSteps: frame.maxSteps,
      newTabId: newTab.id,
      switchResult
    };
  } catch (e) {
    return { ok: false, tool: 'sub_task', error: e.message };
  }
}

/**
 * End the current subtask and return to the main task.
 * Guaranteed return via code — does NOT rely on model memory.
 *
 * The subtask tab is closed, CDP switches back to the return tab,
 * and the result is saved to the main task's scratchpad.
 *
 * @param {string} result — summary of what was accomplished
 * @param {boolean} success — whether the subtask succeeded
 * @returns {Promise<Object>} observation
 */
export async function toolEndSubTask(result, success = true) {
  const memory = runtime._memory;
  if (!memory) return { ok: false, tool: 'end_sub_task', error: 'no_memory' };

  const frame = memory.getCurrentSubtask();
  if (!frame) return { ok: false, tool: 'end_sub_task', error: 'no_active_subtask' };

  const subtaskTabId = runtime.agentTabId; // current tab is the subtask tab

  try {
    // Return to main task tab (guaranteed by code, not model decision)
    const switchResult = await toolSwitchTab(frame.returnTabId);

    // Close the subtask tab (safe — might already be closed)
    try {
      await toolCloseTab(subtaskTabId);
    } catch (_) {}

    // Pop the frame and save result to scratchpad
    const poppedFrame = memory.popSubtask(result || 'нет результата');

    broadcast({ kind: 'log', text: `↗️ Возврат из подзадачи: ${result || 'нет результата'} (успех: ${success})` });

    return {
      ok: true,
      tool: 'end_sub_task',
      result: result || '',
      success,
      subtaskId: poppedFrame?.id,
      stepsUsed: poppedFrame?.stepsUsed || 0,
      switchResult
    };
  } catch (e) {
    return { ok: false, tool: 'end_sub_task', error: e.message };
  }
}

/**
 * Wait for a specified number of seconds.
 */
export async function toolWait(seconds) {
  const ms = Math.min(Math.max(1, seconds || 1), 30) * 1000;
  await sleep(ms);
  return { ok: true, tool: 'wait', seconds: ms / 1000 };
}

// ============================================================
// SMART SLEEP — Two-mode sleep with visual change detection
// ============================================================

/**
 * Compute a perceptual hash from a data URL screenshot.
 * Uses OffscreenCanvas to downsample to 16x16 grayscale, then
 * generates a binary hash based on pixel-vs-average comparison.
 * Robust to minor rendering differences (cursors, sub-pixel shifts).
 *
 * @param {string} dataUrl — data:image/png;base64,...
 * @returns {Promise<string>} perceptual hash fingerprint
 */
async function computePerceptualHash(dataUrl) {
  try {
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);

    const HASH_SIZE = 16;
    const canvas = new OffscreenCanvas(HASH_SIZE, HASH_SIZE);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, HASH_SIZE, HASH_SIZE);
    const imageData = ctx.getImageData(0, 0, HASH_SIZE, HASH_SIZE);

    const grayscale = new Uint8Array(HASH_SIZE * HASH_SIZE);
    let sum = 0;
    for (let i = 0; i < grayscale.length; i++) {
      const r = imageData.data[i * 4];
      const g = imageData.data[i * 4 + 1];
      const b = imageData.data[i * 4 + 2];
      grayscale[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      sum += grayscale[i];
    }
    const avg = sum / grayscale.length;

    let hash = '';
    for (let i = 0; i < grayscale.length; i++) {
      hash += grayscale[i] >= avg ? '1' : '0';
    }

    bitmap.close();
    return hash;
  } catch (e) {
    console.warn('Perceptual hash failed, using fallback:', e);
    return simpleHash(dataUrl);
  }
}

/**
 * Simple hash fallback using base64 byte sampling.
 */
function simpleHash(dataUrl) {
  if (!dataUrl) return '';
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

/**
 * Режим А: «Сторожевой сон» — pause the main loop, poll screenshots via CDP,
 * wake on visual change or timeout.
 *
 * CDP stays attached, heartbeat keeps SW alive. The agent periodically
 * captures screenshots and compares perceptual hashes to detect changes.
 *
 * @param {number} durationSec — max sleep duration in seconds
 * @param {string} reason — why we're sleeping (for logging & model context)
 * @returns {Promise<Object>} observation with wake reason
 */
async function toolWatchfulSleep(durationSec, reason) {
  const memory = runtime._memory;
  if (!memory) return { ok: false, tool: 'sleep', error: 'no_memory' };

  const settings = await getSettings();
  const pollInterval = settings.deep_sleep_poll_interval_ms || 5000;
  const maxDurationMs = Math.max(1000, durationSec * 1000);

  // Save previous phase and enter sleep mode
  const previousPhase = memory.phase;
  memory.setPhase(PHASES.SLEEPING);
  runtime._forceWakeFlag = false; // reset force-wake flag
  broadcast({ kind: 'phase_changed', phase: PHASES.SLEEPING, reason, mode: 'watchful' });
  broadcast({
    kind: 'sleep_started',
    mode: 'watchful',
    reason,
    maxDurationSec: durationSec,
    startedAt: Date.now(),
    pollInterval,
    wakeCondition: 'visual_change_detected'
  });
  broadcast({ kind: 'log', text: `👁️ Watchful sleep started: ${reason} (max ${durationSec}s, poll ${pollInterval}ms)` });

  await setIconMode('sleeping');

  // Capture baseline screenshot and compute perceptual hash
  let baselineHash = '';
  try {
    const baselineScreenshot = await captureScreenshot();
    if (baselineScreenshot) {
      baselineHash = await computePerceptualHash(baselineScreenshot);
    }
  } catch (e) {
    broadcast({ kind: 'log', level: 'error', text: 'Failed to capture baseline for sleep: ' + e.message });
  }

  if (!baselineHash) {
    memory.setPhase(previousPhase);
    return { ok: false, tool: 'sleep', error: 'no_baseline_screenshot' };
  }

  const sleepStartTime = Date.now();
  let pollCount = 0;

  // Set current sleep info for UI rehydration (pages loaded mid-sleep)
  runtime._currentSleep = { mode: 'watchful', reason, maxDurationSec: durationSec, startedAt: sleepStartTime };

  // Polling loop
  while (!runtime.abortFlag && !runtime._forceWakeFlag) {
    await sleep(pollInterval);
    pollCount++;

    if (runtime.abortFlag || runtime._forceWakeFlag) break;

    const elapsed = Date.now() - sleepStartTime;
    if (elapsed >= maxDurationMs) break;

    // Capture new screenshot and compare hashes
    try {
      const currentScreenshot = await captureScreenshot();
      if (!currentScreenshot) continue;

      const currentHash = await computePerceptualHash(currentScreenshot);

      if (currentHash !== baselineHash) {
        // Visual change detected! Debounce: verify after 500ms
        await sleep(500);
        const verifyScreenshot = await captureScreenshot();
        if (verifyScreenshot) {
          const verifyHash = await computePerceptualHash(verifyScreenshot);
          if (verifyHash !== baselineHash) {
            broadcast({ kind: 'log', text: `👁️ Visual change confirmed after ${Math.round(elapsed / 1000)}s, ${pollCount} polls` });
            break;
          }
        }
      }

      // Heartbeat broadcast every 10 polls
      if (pollCount % 10 === 0) {
        broadcast({
          kind: 'infra',
          text: `👁️ Watching... ${Math.round(elapsed / 1000)}s / ${durationSec}s`
        });
      }
    } catch (e) {
      broadcast({ kind: 'log', level: 'error', text: 'Sleep poll error: ' + e.message });
    }
  }

  // Wake up: restore phase
  runtime._currentSleep = null;
  memory.setPhase(previousPhase);
  const totalSleepTime = Date.now() - sleepStartTime;
  const elapsedSec = Math.round(totalSleepTime / 1000);

  // Determine wake reason
  let wakeReason = '';
  if (runtime._forceWakeFlag) {
    wakeReason = 'forced_by_user';
    runtime._forceWakeFlag = false;
  } else if (runtime.abortFlag) {
    wakeReason = 'user_aborted';
  } else if (totalSleepTime >= maxDurationMs) {
    wakeReason = 'timeout';
  } else {
    wakeReason = 'visual_change_detected';
  }

  await setIconMode('working');
  broadcast({ kind: 'phase_changed', phase: previousPhase, reason: 'woke_up' });
  broadcast({
    kind: 'sleep_ended',
    mode: 'watchful',
    wakeReason,
    elapsedSec,
    pollCount
  });
  broadcast({ kind: 'log', text: `��️ Watchful sleep ended: ${wakeReason} after ${elapsedSec}s` });

  return {
    ok: true,
    tool: 'sleep',
    terminal: false,
    mode: 'watchful',
    sleepDurationMs: totalSleepTime,
    pollCount,
    wakeReason,
    elapsedFormatted: `${elapsedSec}сек`
  };
}

/**
 * Режим Б: «Глубокая гибернация» — detach CDP, stop heartbeat,
 * save state, set one-shot chrome.alarms timer, let SW unload.
 *
 * When Chrome fires the alarm, the SW wakes up (attemptResume
 * in background.js handles re-attachment and loop continuation).
 *
 * Zero CPU/RAM during hibernation. The tab stays open but
 * the extension is completely unloaded from memory.
 *
 * @param {number} durationSec — hibernation duration in seconds
 * @param {string} reason — why we're hibernating
 * @returns {Promise<Object>} observation (will be processed by vision_loop before sleep)
 */
async function toolDeepSleep(durationSec, reason) {
  const memory = runtime._memory;
  if (!memory) return { ok: false, tool: 'sleep', error: 'no_memory' };

  const maxDurationMs = Math.max(60000, durationSec * 1000); // min 1 minute

  broadcast({ kind: 'log', text: `🕳️ Deep sleep requested: ${reason} (hibernating for ${durationSec}s)` });
  broadcast({
    kind: 'sleep_started',
    mode: 'deep_sleep',
    reason,
    maxDurationSec: durationSec,
    startedAt: Date.now(),
    wakeCondition: 'alarm_timer'
  });

  // Store sleep context in runtime so vision_loop can inject it into history
  // before the SW is unloaded
  runtime._currentSleep = { mode: 'deep_sleep', reason, maxDurationSec: durationSec, startedAt: Date.now() };
  runtime._sleepResult = {
    mode: 'deep_sleep',
    reason,
    requestedDurationSec: durationSec,
    startedAt: Date.now()
  };

  // Detach CDP to remove "debugger" banner and free the tab
  try { await cdpDetach(); } catch (_) {}

  // Create the deep-sleep alarm and save state (inside persistence)
  // This also stops the heartbeat and sets the alarm via chrome.alarms
  const alarmName = await persistDeepSleep(
    maxDurationMs,
    () => runtime,
    () => runtime._memory
  );

  // Store alarm name in runtime for tracking (if SW somehow stays alive)
  runtime._deepSleepAlarmName = alarmName;

  // Set icon to sleeping
  await setIconMode('sleeping');

  // Return observation — vision_loop will process this, inject wake context
  // into history, then the SW will unload naturally (no more event loop)
  return {
    ok: true,
    tool: 'sleep',
    terminal: false,
    mode: 'deep_sleep',
    alarmName,
    requestedDurationSec: durationSec,
    reason,
    note: 'Service Worker will hibernate now. Will resume via alarm.'
  };
}

/**
 * Unified sleep tool — dispatches to watchful or deep sleep based on wake_on_change.
 *
 * @param {number} durationSec — max sleep duration in seconds (1–86400)
 * @param {boolean} wakeOnChange — true = watchful (CDP polling), false = deep hibernate
 * @param {string} reason — why we're sleeping (for logging & model context)
 * @returns {Promise<Object>} observation with wake reason
 */
export async function toolSleep(durationSec, wakeOnChange, reason) {
  // Clamp duration: 1 second to 24 hours
  const clampedSec = Math.max(1, Math.min(86400, durationSec || 60));
  const safeReason = reason || 'no reason provided';

  if (wakeOnChange) {
    return await toolWatchfulSleep(clampedSec, safeReason);
  } else {
    return await toolDeepSleep(clampedSec, safeReason);
  }
}

/**
 * @deprecated — kept for backward compatibility, redirects to unified toolSleep
 */
export async function toolSleepUntilChange(reason) {
  return await toolSleep(300, true, reason);
}

// ============================================================
// PERSISTENT MEMORY — Events API backed long-term memory
// ============================================================

async function getCurrentPageContext() {
  const ctx = {};
  try {
    const tab = await chrome.tabs.get(runtime.agentTabId);
    ctx.currentUrl = tab?.url || '';
    ctx.pageTitle = tab?.title || '';
  } catch (_) {}
  try {
    ctx.task = runtime.task || runtime.currentTask || runtime._task || '';
  } catch (_) {}
  return ctx;
}

export async function toolRemember(action = {}) {
  try {
    const settings = await getSettings();
    const context = await getCurrentPageContext();
    const result = await rememberEvent(settings, {
      kind: action.kind || 'note',
      fields: action.fields || {}
    }, context);
    return {
      ok: !!result.ok,
      tool: 'remember',
      stored: !!result.ok,
      ...result
    };
  } catch (e) {
    return { ok: false, tool: 'remember', error: e.message };
  }
}

export async function toolRecall(action = {}) {
  try {
    const settings = await getSettings();
    const result = await recallEvents(settings, {
      kind: action.kind || '',
      filters: Array.isArray(action.filters) ? action.filters : [],
      limit: action.limit || 10
    });
    return {
      ok: !!result.ok,
      tool: 'recall',
      hint: result.found
        ? 'Найдены записи в постоянной памяти. Если задача запрещает дублирование — пропустите повторное действие.'
        : 'Записей не найдено. Можно продолжать действие и после результата сохранить факт через remember.',
      ...result
    };
  } catch (e) {
    return { ok: false, tool: 'recall', error: e.message };
  }
}

// ============================================================
// MASTER DISPATCH — route a tool call to the right handler
// ============================================================

/**
 * Execute a vision tool call from the AI model.
 *
 * @param {Object} action — { tool, x?, y?, text?, key?, direction?, amount?, url?, seconds?, value?, clear?, click_count? }
 * @returns {Promise<Object>} observation
 */
export async function executeVisionTool(action) {
  if (!action || !action.tool) {
    return { ok: false, error: 'no_tool_specified' };
  }

  const tool = action.tool;

  switch (tool) {
    case 'click_at':
      return await toolClickAt(action.x, action.y, action.click_count || 1);

    case 'right_click_at':
      return await toolRightClickAt(action.x, action.y);

    case 'type_at':
      return await toolTypeAt(action.x, action.y, action.text || '', action.clear !== false);

    case 'paste_text':
      return await toolPasteText(action.x, action.y, action.text || '');

    case 'set_value_via_api':
      return await toolSetValueViaApi(action.x, action.y, action.text || '');

    case 'type_code':
      return await toolTypeCode(action.x, action.y, action.text || '');

    case 'press_key':
      return await toolPressKey(action.key);

    case 'scroll':
      return await toolScroll(
        action.direction || 'down',
        action.amount || 300,
        action.x ?? 500,
        action.y ?? 500
      );

    case 'hover_at':
      return await toolHoverAt(action.x, action.y);

    case 'swipe':
      return await toolSwipe(
        action.x ?? 500,
        action.y ?? 500,
        action.direction || 'left',
        action.distance || 300,
        action.duration,
        action.humanize || {}
      );

    case 'select_at':
      return await toolSelectAt(action.x, action.y, action.value || '');

    case 'checkbox_at':
      return await toolCheckboxAt(action.x, action.y);

    case 'navigate':
      return await toolNavigate(action.url);

    case 'back':
      return await toolBack();

    case 'switch_tab':
      return await toolSwitchTab(action.tab_id);

    case 'close_tab':
      return await toolCloseTab(action.tab_id);

    case 'jump_to_node':
      return await toolJumpToNode(action.node_id);

    case 'mark_node':
      return await toolMarkNode(action.node_id, action.status, action.summary);

    case 'sub_task':
      return await toolSubTask(action.goal, action.done_trigger, action.url, action.max_steps);

    case 'end_sub_task':
      return await toolEndSubTask(action.result, action.success !== false);

    case 'wait':
      return await toolWait(action.seconds || 3);

    case 'sleep_until_change':
      return await toolSleepUntilChange(action.reason || '');

    case 'sleep':
      return await toolSleep(
        action.duration_seconds || action.seconds || 60,
        action.wake_on_change !== false, // default true (watchful)
        action.reason || ''
      );

    case 'remember':
      return await toolRemember(action);

    case 'recall':
      return await toolRecall(action);

    case 'done':
      return { ok: true, tool: 'done', terminal: true, answer: action.answer || '' };

    case 'fail':
      return { ok: false, tool: 'fail', terminal: true, reason: action.reason || 'model reported failure' };

    default:
      return { ok: false, error: 'unknown_tool', tool };
  }
}

/**
 * Detect if the page has navigated to a new URL or shows a modal overlay.
 * Used to interrupt action chains when something unexpected happens.
 *
 * @param {string} expectedUrl — URL before the chain started
 * @returns {Promise<{interrupted: boolean, reason?: string}>}
 */
async function detectChainInterrupt(expectedUrl) {
  try {
    // Check if URL changed (navigation occurred)
    let currentUrl = '';
    const tab = await chrome.tabs.get(runtime.agentTabId);
    currentUrl = tab?.url || '';

    if (expectedUrl && currentUrl && currentUrl !== expectedUrl) {
      return { interrupted: true, reason: `navigation: ${currentUrl.slice(0, 80)}` };
    }

    // Check for modal overlay or dialog via CDP
    if (runtime.cdpAttached) {
      try {
        const result = await cdpSend('Runtime.evaluate', {
          expression: `(function() {
            // Check for common modal/overlay patterns
            const modals = document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="overlay"], [class*="popup"], [class*="dialog"]');
            for (const m of modals) {
              const style = getComputedStyle(m);
              if (style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0') {
                return true;
              }
            }
            return false;
          })()`,
          returnByValue: true
        });
        if (result?.result?.value === true) {
          return { interrupted: true, reason: 'modal_detected' };
        }
      } catch (_) {}
    }

    // Check for abort or pause flags
    if (runtime.abortFlag || runtime.pauseFlag) {
      return { interrupted: true, reason: runtime.abortFlag ? 'aborted' : 'paused' };
    }

    return { interrupted: false };
  } catch (_) {
    return { interrupted: false };
  }
}

/**
 * Execute a chain of vision actions sequentially with human-like delays.
 * Implements safety interrupters: breaks the chain if navigation, modal, or error occurs.
 *
 * @param {Object} chain — { _isChain: true, actions: Array, think: string }
 * @returns {Promise<Object>} combined observation
 */
export async function executeActionChain(chain) {
  if (!chain || !chain._isChain || !Array.isArray(chain.actions) || chain.actions.length === 0) {
    return { ok: false, error: 'invalid_chain', tool: 'action_chain' };
  }

  const results = [];
  let expectedUrl = '';

  // Get current URL before chain starts (for navigation detection)
  try {
    const tab = await chrome.tabs.get(runtime.agentTabId);
    expectedUrl = tab?.url || '';
  } catch (_) {}

  broadcast({ kind: 'log', text: `⛓️ Executing action chain: ${chain.actions.length} actions` });

  for (let i = 0; i < chain.actions.length; i++) {
    const action = chain.actions[i];

    // Safety interrupter: check for navigation, modals, abort
    const interrupt = await detectChainInterrupt(expectedUrl);
    if (interrupt.interrupted) {
      broadcast({
        kind: 'log',
        level: 'warn',
        text: `⛓️ Chain interrupted at action ${i + 1}/${chain.actions.length}: ${interrupt.reason}`
      });
      results.push({
        ok: false,
        tool: action.tool,
        error: `chain_interrupted: ${interrupt.reason}`,
        interruptedAt: i + 1
      });
      break;
    }

    // Human-like delay before action
    // Short delay for simple actions (type, click), longer for important ones
    const isSimpleAction = (action.tool === 'type_at' || action.tool === 'paste_text' || action.tool === 'type_code' || action.tool === 'set_value_via_api' || action.tool === 'press_key');
    const isImportantAction = (action.tool === 'navigate' || action.tool === 'back');

    if (i > 0) {
      if (isSimpleAction) {
        // Quick keystroke/mouse delay (80–200ms)
        await humanSleep(80, 200);
      } else if (isImportantAction) {
        // "Thinking" pause before navigation (300–800ms)
        await humanThinkPause(300, 800);
      } else {
        // Standard human delay between clicks (100–300ms)
        await humanSleep(100, 300);
      }
    }

    // Execute the action
    broadcast({ kind: 'log', text: `⛓️ [${i + 1}/${chain.actions.length}] ${action.tool}` });

    let observation;
    try {
      observation = await executeVisionTool(action);
    } catch (e) {
      observation = { ok: false, error: e.message, tool: action.tool };
    }

    results.push(observation);

    // If action failed, break the chain
    if (!observation.ok) {
      broadcast({
        kind: 'log',
        level: 'warn',
        text: `⛓️ Chain broken at action ${i + 1}: ${observation.error || 'action failed'}`
      });
      break;
    }

    // If action was terminal (done/fail), break
    if (observation.terminal) {
      break;
    }

    // Small "reaction" pause after action (50–150ms)
    await humanSleep(50, 150);
  }

  // Build combined observation
  const allOk = results.every(r => r.ok);
  const lastResult = results[results.length - 1];

  return {
    ok: allOk,
    tool: 'action_chain',
    chainLength: chain.actions.length,
    executed: results.length,
    results,
    // Return last action's terminal status if any
    terminal: lastResult?.terminal || false,
    answer: lastResult?.answer,
    reason: lastResult?.reason
  };
}

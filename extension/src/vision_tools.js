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
//   type_at        — Click at (x, y), clear field, type text
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

import { runtime, sleep, humanDelay, humanSleep, humanThinkPause, broadcast, setIconMode } from './bus.js';
import {
  cdpClick, cdpType, cdpPressKey, cdpHover, cdpSend,
  cdpAttach, cdpDetach,
  waitPageReady, captureScreenshot
} from './cdp.js';
import { PHASES } from './task_memory.js';
import { getSettings } from './settings.js';
import { startDeepSleep as persistDeepSleep, stopHeartbeat } from './persistence.js';

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
  } catch (_) {}

  return { width: 1280, height: 800 };
}

// ============================================================
// OVERLAY DETECTION (pre-click DOM probe for blocking elements)
// ============================================================

/**
 * Detect if a point is covered by a likely overlay/modal element.
 * Uses document.elementFromPoint and traverses up the DOM to find
 * elements with high z-index, position: fixed/sticky, or common
 * modal/overlay CSS classes.
 *
 * @param {number} x — viewport X in pixels
 * @param {number} y — viewport Y in pixels
 * @returns {Promise<Object>} { blocked: boolean, elementInfo?: { tag, classes, role, description } }
 */
export async function probeOverlayAtPoint(x, y) {
  const script = `(function() {
    var el = document.elementFromPoint(${x}, ${y});
    if (!el || el.tagName === 'HTML' || el.tagName === 'BODY') return { blocked: false };
    
    var cur = el;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      var style = window.getComputedStyle(cur);
      var zIndex = parseInt(style.zIndex) || 0;
      var position = style.position;
      var rect = cur.getBoundingClientRect();
      var w = window.innerWidth;
      var h = window.innerHeight;
      
      // Heuristics for overlays:
      // 1. High z-index (usually > 100) AND fixed/absolute position
      // 2. Fixed position AND covers significant area (> 20% of screen)
      // 3. Role "dialog" or "alertdialog"
      // 4. Common class/id patterns
      var isOverlay = false;
      var reason = "";
      
      var role = (cur.getAttribute('role') || '').toLowerCase();
      if (role === 'dialog' || role === 'alertdialog' || role === 'alert') {
        isOverlay = true;
        reason = "role=" + role;
      }
      
      var className = (cur.className || '').toString().toLowerCase();
      var id = (cur.id || '').toLowerCase();
      var combined = className + " " + id;
      if (/(modal|overlay|popup|dialog|consent|cookie|banner|gate|interstitial|paywall)/.test(combined)) {
        isOverlay = true;
        reason = "class/id pattern match";
      }
      
      if ((position === 'fixed' || position === 'sticky') && zIndex > 100) {
        isOverlay = true;
        reason = "fixed/sticky z-index > 100";
      }
      
      if (position === 'fixed') {
        var areaRatio = (rect.width * rect.height) / (w * h);
        if (areaRatio > 0.3) { // Covers 30% of screen
            isOverlay = true;
            reason = "large fixed element";
        }
      }
      
      if (isOverlay) {
        return {
          blocked: true,
          elementInfo: {
            tag: cur.tagName.toLowerCase(),
            classes: className.slice(0, 100),
            id: id,
            role: role,
            zIndex: zIndex,
            position: position,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
            reason: reason
          }
        };
      }
      
      cur = cur.parentElement;
    }
    return { blocked: false };
  })()`;

  try {
    const result = await Promise.race([
      cdpSend('Runtime.evaluate', { expression: script, returnByValue: true }),
      new Promise(resolve => setTimeout(() => resolve(null), 400))
    ]);

    if (result?.result?.value && typeof result.result.value === 'object' && 'blocked' in result.result.value) {
      return result.result.value;
    }
  } catch (_) {}

  return { blocked: false };
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

    // --- Overlay detection (read-only DOM probe, ≤400 ms) ---
    // Check if the click target is covered by a likely overlay/modal element.
    const overlay = await probeOverlayAtPoint(x, y);
    if (overlay.blocked) {
      return {
        ok: false, 
        tool: 'click_at', 
        error: 'overlay_blocked',
        normalized: { x: nx, y: ny }, 
        actual: { x, y },
        overlay: overlay.elementInfo,
        hint: 'Клик заблокирован элементом поверх страницы (возможно, это попап, баннер куки или модальное окно). Пожалуйста, сначала найдите способ закрыть его (найдите крестик или кнопку "Принять/Закрыть").'
      };
    }

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
 * Type text at normalized coordinates.
 * Click to focus → Clear field (Ctrl+A, Delete) → Insert text.
 * Handles any Unicode: Cyrillic, CJK, emoji, etc.
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

    return { ok: true, tool: 'type_at', normalized: { x: nx, y: ny }, length: (text || '').length, cleared: clearFirst };
  } catch (e) {
    return { ok: false, tool: 'type_at', error: e.message, normalized: { x: nx, y: ny } };
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
  broadcast({ kind: 'log', text: `👁️ Watchful sleep ended: ${wakeReason} after ${elapsedSec}s` });

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

    case 'type_at':
      return await toolTypeAt(action.x, action.y, action.text || '', action.clear !== false);

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
    const isSimpleAction = (action.tool === 'type_at' || action.tool === 'press_key');
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

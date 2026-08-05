// content.js — Minimal content script for Vision-First Agent.
//
// Provides ONLY page-level information and lightweight polling.
// All interaction (click, type, scroll, hover) is handled via CDP
// in vision_tools.js — no DOM manipulation needed here.
//
// Retained capabilities:
//   - pageInfo: URL, title, body text
//   - waitForCompletion: polling engine for long-running processes
//   - history: back/forward navigation

(function () {

  // ============================================================
  // PAGE INFO
  // ============================================================

  function getPageInfo() {
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 4000)
    };
  }

  // ============================================================
  // HISTORY NAVIGATION
  // ============================================================

  function historyAction(direction) {
    if (direction === 'back') history.back();
    else if (direction === 'forward') history.forward();
    return { ok: true, direction };
  }

  // ============================================================
  // WAIT FOR COMPLETION (lightweight polling engine)
  // ============================================================

  /**
   * Local polling engine for long-running processes.
   * Uses MutationObserver + periodic checks — zero AI calls during wait.
   *
   * Supported condition types:
   *   - text_appear: wait for text string to appear anywhere in body
   *   - text_disappear: wait for text to vanish from body
   *   - url_change: wait for URL to contain a substring
   *
   * @param {Object} condition - { type, text?, contains? }
   * @param {number} timeoutMs - Maximum wait time
   * @returns {Promise<{ok, ...}>}
   */
  function waitForCompletion(condition, timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      const INTERVALS = [500, 500, 1000, 1000, 2000, 2000, 3000, 5000];
      let pollIndex = 0;
      let settled = false;
      let observer = null;
      let pollTimer = null;

      const elapsed = () => Date.now() - start;
      const currentInterval = () => INTERVALS[Math.min(pollIndex, INTERVALS.length - 1)];

      function cleanup() {
        if (settled) return;
        settled = true;
        if (observer) { try { observer.disconnect(); } catch (_) {} }
        if (pollTimer) { clearTimeout(pollTimer); }
      }

      function succeed(detail) {
        cleanup();
        resolve({ ok: true, elapsed: elapsed(), ...detail });
      }

      function fail(reason) {
        cleanup();
        resolve({ ok: false, error: reason, elapsed: elapsed() });
      }

      // --- Error text detection ---
      const ERROR_TEXTS = ['error', 'failed', 'failure', 'ошибка', 'не удалось', 'something went wrong', 'try again'];

      function checkForErrors() {
        try {
          const errorEls = document.querySelectorAll(
            '[role="alert"], .error, .alert-danger, .alert-error, .error-message, .toast-error'
          );
          for (const el of errorEls) {
            const cs = window.getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden') continue;
            const txt = (el.innerText || '').toLowerCase();
            for (const err of ERROR_TEXTS) {
              if (txt.includes(err)) {
                return el.innerText.trim().slice(0, 300);
              }
            }
          }
        } catch (_) {}
        return null;
      }

      // --- Condition checks ---

      function checkTextAppear() {
        try {
          const bodyText = document.body.innerText || '';
          if (bodyText.includes(condition.text)) {
            succeed({ reason: 'text_appeared', text: condition.text });
            return true;
          }
        } catch (_) {}
        return false;
      }

      function checkTextDisappear() {
        try {
          const bodyText = document.body.innerText || '';
          if (!bodyText.includes(condition.text)) {
            succeed({ reason: 'text_disappeared', text: condition.text });
            return true;
          }
        } catch (_) {}
        return false;
      }

      function checkUrlChange() {
        if (location.href.includes(condition.contains || '')) {
          succeed({ reason: 'url_changed', url: location.href });
          return true;
        }
        return false;
      }

      const checkFn = {
        'text_appear': checkTextAppear,
        'text_disappear': checkTextDisappear,
        'url_change': checkUrlChange
      }[condition.type];

      if (!checkFn) {
        fail('unknown_condition_type: ' + condition.type);
        return;
      }

      // --- MutationObserver for text-based conditions ---
      if (['text_appear', 'text_disappear'].includes(condition.type)) {
        try {
          observer = new MutationObserver(() => {
            if (settled) return;
            setTimeout(() => {
              if (!settled) {
                const error = checkForErrors();
                if (error) { fail('page_error: ' + error); return; }
                checkFn();
              }
            }, 100);
          });
          observer.observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true
          });
        } catch (_) {}
      }

      // --- Polling loop ---
      function poll() {
        if (settled) return;
        if (elapsed() >= timeoutMs) {
          fail('wait_timeout');
          return;
        }

        const error = checkForErrors();
        if (error) { fail('page_error: ' + error); return; }

        checkFn();
        if (settled) return;

        pollIndex++;
        pollTimer = setTimeout(poll, currentInterval());
      }

      // Initial check
      const error = checkForErrors();
      if (error) { fail('page_error: ' + error); return; }
      checkFn();
      if (settled) return;

      pollTimer = setTimeout(poll, currentInterval());
    });
  }

  // ============================================================
  // EXTRACT TEXT (lightweight, no selectors needed)
  // ============================================================

  function extractText() {
    return { ok: true, value: (document.body.innerText || '').trim().slice(0, 4000) };
  }

  // ============================================================
  // MESSAGE LISTENER
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    let result;
    try {
      switch (msg.action) {
        case 'pageInfo':
          result = getPageInfo();
          break;
        case 'history':
          result = historyAction(msg.direction);
          break;
        case 'wait_for_completion':
          waitForCompletion(msg.condition, msg.timeoutMs || 120000).then(sendResponse);
          return true;
        case 'extract':
          result = extractText();
          break;
        default:
          result = { ok: false, error: 'unknown_action', action: msg.action };
      }
    } catch (e) {
      result = { ok: false, error: String(e && e.message || e) };
    }
    sendResponse(result);
    return true;
  });
})();

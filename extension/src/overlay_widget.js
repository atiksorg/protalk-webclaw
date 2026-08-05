// overlay_widget.js — Floating overlay widget on all pages
//
// Shows a floating widget in the bottom-right corner that displays:
// - Agent status (running / paused / finished / idle)
// - Current phase (planning / extracting / filtering / confirming / executing)
// - Step counter + token usage
// - AI reasoning/thinking
// - Current action being executed
// - Observation/result of the last action
// - Infrastructure messages (screenshot, DOM snapshot, etc.)
//
// Clicking the widget opens the monitoring page (sidepanel.html).
// This runs as a content script on ALL pages (injected via manifest.json).

(function () {
  // ============================================================
  // STATE
  // ============================================================

  let agentRunning = false;
  let agentPaused = false;
  let currentStep = 0;
  let currentPhase = 'idle';
  let totalTokens = 0;
  let tokenLimit = 0;
  let modelName = '';
  let currentThought = '';
  let currentAction = '';
  let currentObservation = '';
  let lastInfraText = '';
  let modelThinking = false; // true while model is processing
  let widgetDismissed = false; // true when user manually dismissed the widget
  let widgetAutoHideTimer = null; // timer for auto-hiding widget when idle
  // Sleep state
  let isSleeping = false;
  let sleepMode = ''; // 'watchful' | 'deep_sleep'
  let sleepReason = '';
  let sleepMaxDurationSec = 0;
  let sleepStartedAt = 0;
  let sleepTimerInterval = null;
  let sleepElapsedSec = 0;

  // ============================================================
  // CREATE DOM
  // ============================================================

  const overlay = document.createElement('div');
  overlay.id = 'webclaw-overlay';
  overlay.innerHTML = `
    <div class="webclaw-widget" id="webclaw-widget">
      <div class="webclaw-header" id="webclaw-header">
        <span class="webclaw-logo">🦞</span>
        <span class="webclaw-status" id="webclaw-status">Ожидание</span>
        <span class="webclaw-model" id="webclaw-model"></span>
        <span class="webclaw-step" id="webclaw-step"></span>
        <button class="webclaw-close" id="webclaw-close" title="Скрыть виджет">×</button>
      </div>
      <div class="webclaw-body" id="webclaw-body">
        <!-- Phase + meta info -->
        <div class="webclaw-meta" id="webclaw-meta" style="display:none">
          <div class="webclaw-phase-row">
            <span class="webclaw-phase-badge" id="webclaw-phase-badge"></span>
            <span class="webclaw-tokens" id="webclaw-tokens"></span>
          </div>
          <div class="webclaw-phase-bar">
            <div class="webclaw-phase-dot" data-phase="planning"></div>
            <div class="webclaw-phase-dot" data-phase="extracting"></div>
            <div class="webclaw-phase-dot" data-phase="filtering"></div>
            <div class="webclaw-phase-dot" data-phase="confirming"></div>
            <div class="webclaw-phase-dot" data-phase="executing"></div>
          </div>
        </div>
        <!-- Infrastructure status -->
        <div class="webclaw-infra" id="webclaw-infra" style="display:none">
          <div class="webclaw-infra-text" id="webclaw-infra-text"></div>
        </div>
        <!-- Model thinking indicator -->
        <div class="webclaw-thinking" id="webclaw-thinking" style="display:none">
          <div class="webclaw-thinking-dots">
            <span></span><span></span><span></span>
          </div>
          <span class="webclaw-thinking-text">Модель думает...</span>
        </div>
        <!-- AI Thought -->
        <div class="webclaw-thought" id="webclaw-thought" style="display:none">
          <div class="webclaw-thought-label">💭 ИИ рассуждает:</div>
          <div class="webclaw-thought-text" id="webclaw-thought-text"></div>
        </div>
        <!-- Action -->
        <div class="webclaw-action" id="webclaw-action" style="display:none">
          <div class="webclaw-action-label">🎯 Действие:</div>
          <div class="webclaw-action-text" id="webclaw-action-text"></div>
        </div>
        <!-- Observation -->
        <div class="webclaw-observation" id="webclaw-observation" style="display:none">
          <div class="webclaw-observation-label">📊 Результат:</div>
          <div class="webclaw-observation-text" id="webclaw-observation-text"></div>
        </div>
        <!-- Sleep Panel (shown when agent is sleeping) -->
        <div class="webclaw-sleep-panel" id="webclaw-sleep-panel" style="display:none">
          <div class="webclaw-sleep-header">
            <span class="webclaw-sleep-icon" id="webclaw-sleep-icon">👁️</span>
            <span class="webclaw-sleep-title" id="webclaw-sleep-title">Наблюдение</span>
            <span class="webclaw-sleep-timer" id="webclaw-sleep-timer">0:00</span>
          </div>
          <div class="webclaw-sleep-reason" id="webclaw-sleep-reason"></div>
          <div class="webclaw-sleep-condition" id="webclaw-sleep-condition"></div>
          <div class="webclaw-sleep-bar" id="webclaw-sleep-bar">
            <div class="webclaw-sleep-bar-fill" id="webclaw-sleep-bar-fill"></div>
          </div>
          <button class="webclaw-sleep-wake-btn" id="webclaw-sleep-wake-btn">⚡ Разбудить сейчас</button>
        </div>
        <!-- Sleep result banner (shown briefly after waking) -->
        <div class="webclaw-sleep-result" id="webclaw-sleep-result" style="display:none">
          <span class="webclaw-sleep-result-icon" id="webclaw-sleep-result-icon">🔔</span>
          <span class="webclaw-sleep-result-text" id="webclaw-sleep-result-text"></span>
        </div>
        <!-- Empty state (shown when agent is idle) -->
        <div class="webclaw-empty" id="webclaw-empty">
          <div class="webclaw-empty-icon">🦞</div>
          <div class="webclaw-empty-text">Агент не запущен</div>
          <div class="webclaw-empty-hint">Запустите задачу из popup</div>
        </div>
      </div>
      <div class="webclaw-footer" id="webclaw-footer">
        <span class="webclaw-footer-text">Нажмите для мониторинга</span>
      </div>
    </div>
  `;

  // ============================================================
  // STYLES
  // ============================================================

  const style = document.createElement('style');
  style.textContent = `
    #webclaw-overlay {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 9999999;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      pointer-events: none;
    }
    #webclaw-overlay.webclaw-cdp-hidden {
      display: none !important;
    }
    #webclaw-widget {
      width: 320px;
      background: rgba(17, 20, 27, 0.95);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      border: 1px solid #2a2f3a;
      border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      pointer-events: auto;
      overflow: hidden;
      transition: all 0.3s ease;
    }
    #webclaw-widget:hover {
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    }
    .webclaw-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      background: #151820;
      border-bottom: 1px solid #1f2330;
      cursor: pointer;
    }
    .webclaw-close {
      background: none;
      border: none;
      color: #6b7280;
      font-size: 16px;
      cursor: pointer;
      padding: 0 2px;
      line-height: 1;
      border-radius: 4px;
      transition: color 0.15s, background 0.15s;
    }
    .webclaw-close:hover {
      color: #f87171;
      background: rgba(248, 113, 113, 0.12);
    }
    .webclaw-logo {
      font-size: 18px;
    }
    .webclaw-status {
      flex: 1;
      min-width: 0;
      font-size: 12px;
      color: #9aa3af;
      font-weight: 500;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .webclaw-status.running { color: #4ade80; }
    .webclaw-status.paused  { color: #facc15; }
    .webclaw-status.error   { color: #f87171; }
    .webclaw-status.done    { color: #60a5fa; }
    .webclaw-model {
      font-size: 9px;
      color: #8b5cf6;
      background: rgba(139, 92, 246, 0.15);
      padding: 2px 7px;
      border-radius: 4px;
      max-width: 120px;
      min-width: 40px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .webclaw-step {
      font-size: 11px;
      color: #6b7280;
      font-variant-numeric: tabular-nums;
    }
    .webclaw-body {
      padding: 12px 14px;
      max-height: 360px;
      overflow-y: auto;
    }

    /* Meta (phase + tokens) */
    .webclaw-meta {
      margin-bottom: 10px;
    }
    .webclaw-phase-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
    }
    .webclaw-phase-badge {
      font-size: 10px;
      font-weight: 600;
      color: #38bdf8;
      background: rgba(56, 189, 248, 0.12);
      padding: 2px 8px;
      border-radius: 4px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .webclaw-tokens {
      font-size: 10px;
      color: #facc15;
      font-variant-numeric: tabular-nums;
      font-weight: 600;
    }
    .webclaw-phase-bar {
      display: flex;
      gap: 3px;
    }
    .webclaw-phase-dot {
      flex: 1;
      height: 3px;
      border-radius: 2px;
      background: #1f2330;
      transition: background 0.3s;
    }
    .webclaw-phase-dot.done    { background: #16a34a; }
    .webclaw-phase-dot.current { background: #38bdf8; animation: wc-pulse 1.5s ease-in-out infinite; }
    @keyframes wc-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }

    /* Infrastructure */
    .webclaw-infra {
      margin-bottom: 8px;
      padding: 4px 0;
    }
    .webclaw-infra-text {
      font-size: 11px;
      color: #6b7280;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    /* Model thinking indicator */
    .webclaw-thinking {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
      padding: 6px 0;
    }
    .webclaw-thinking-dots {
      display: flex;
      gap: 3px;
    }
    .webclaw-thinking-dots span {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #6366f1;
      animation: wc-dot-pulse 1.2s ease-in-out infinite;
    }
    .webclaw-thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
    .webclaw-thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
    @keyframes wc-dot-pulse {
      0%, 100% { opacity: 0.3; transform: scale(0.8); }
      50% { opacity: 1; transform: scale(1.2); }
    }
    .webclaw-thinking-text {
      font-size: 11px;
      color: #a5b4fc;
      font-weight: 500;
    }

    /* Thought / Action / Observation */
    .webclaw-thought,
    .webclaw-action,
    .webclaw-observation {
      margin-bottom: 10px;
    }
    .webclaw-thought-label,
    .webclaw-action-label,
    .webclaw-observation-label {
      font-size: 10px;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .webclaw-thought-text {
      font-size: 12px;
      color: #c4b5fd;
      font-style: italic;
      line-height: 1.4;
      max-height: 80px;
      overflow-y: auto;
    }
    .webclaw-action-text {
      font-size: 12px;
      color: #93c5fd;
      font-weight: 500;
    }
    .webclaw-observation-text {
      font-size: 12px;
      color: #86efac;
    }
    .webclaw-observation-text.error {
      color: #fca5a5;
    }

    /* Empty state */
    .webclaw-empty {
      text-align: center;
      padding: 20px 14px;
    }
    .webclaw-empty-icon {
      font-size: 32px;
      margin-bottom: 8px;
    }
    .webclaw-empty-text {
      font-size: 13px;
      color: #e6e8eb;
      margin-bottom: 4px;
    }
    .webclaw-empty-hint {
      font-size: 11px;
      color: #6b7280;
    }

    /* Footer */
    .webclaw-footer {
      padding: 8px 14px;
      background: #11141b;
      border-top: 1px solid #1f2330;
      cursor: pointer;
      text-align: center;
    }
    .webclaw-footer-text {
      font-size: 10px;
      color: #6b7280;
    }
    .webclaw-footer:hover .webclaw-footer-text {
      color: #9aa3af;
    }

    /* ============================================================
       SLEEP PANEL — Watchful 👁️ & Deep Sleep 🌙
       ============================================================ */

    .webclaw-sleep-panel {
      margin-bottom: 8px;
      padding: 10px 12px;
      border-radius: 8px;
      border: 1px solid;
      transition: all 0.3s ease;
    }
    .webclaw-sleep-panel.watchful {
      background: rgba(56, 189, 248, 0.08);
      border-color: rgba(56, 189, 248, 0.25);
    }
    .webclaw-sleep-panel.deep-sleep {
      background: rgba(99, 102, 241, 0.08);
      border-color: rgba(99, 102, 241, 0.25);
    }

    .webclaw-sleep-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .webclaw-sleep-icon {
      font-size: 20px;
      line-height: 1;
    }
    .webclaw-sleep-panel.watchful .webclaw-sleep-icon {
      animation: wc-sleep-scan 2s ease-in-out infinite;
      color: #38bdf8;
    }
    .webclaw-sleep-panel.deep-sleep .webclaw-sleep-icon {
      animation: wc-sleep-zzz 2.5s ease-in-out infinite;
    }
    @keyframes wc-sleep-scan {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.15); opacity: 0.7; }
    }
    @keyframes wc-sleep-zzz {
      0%, 100% { transform: scale(1); opacity: 1; }
      33% { transform: scale(1.08) translateY(-1px); opacity: 0.8; }
      66% { transform: scale(0.95) translateY(1px); opacity: 0.9; }
    }

    .webclaw-sleep-title {
      flex: 1;
      font-size: 12px;
      font-weight: 600;
      color: #e6e8eb;
    }
    .webclaw-sleep-panel.watchful .webclaw-sleep-title { color: #38bdf8; }
    .webclaw-sleep-panel.deep-sleep .webclaw-sleep-title { color: #818cf8; }

    .webclaw-sleep-timer {
      font-size: 13px;
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0.5px;
      min-width: 42px;
      text-align: right;
    }
    .webclaw-sleep-panel.watchful .webclaw-sleep-timer { color: #7dd3fc; }
    .webclaw-sleep-panel.deep-sleep .webclaw-sleep-timer { color: #a5b4fc; }

    .webclaw-sleep-reason {
      font-size: 11px;
      color: #9ca3af;
      line-height: 1.4;
      margin-bottom: 6px;
      max-height: 36px;
      overflow: hidden;
    }
    .webclaw-sleep-condition {
      font-size: 10px;
      color: #6b7280;
      margin-bottom: 8px;
      font-style: italic;
    }

    .webclaw-sleep-bar {
      height: 3px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 10px;
    }
    .webclaw-sleep-bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 1s linear;
      width: 0%;
    }
    .webclaw-sleep-panel.watchful .webclaw-sleep-bar-fill {
      background: linear-gradient(90deg, #38bdf8, #0ea5e9);
    }
    .webclaw-sleep-panel.deep-sleep .webclaw-sleep-bar-fill {
      background: linear-gradient(90deg, #6366f1, #8b5cf6);
    }

    .webclaw-sleep-wake-btn {
      display: block;
      width: 100%;
      padding: 7px 0;
      font-size: 11px;
      font-weight: 600;
      color: #e6e8eb;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 6px;
      cursor: pointer;
      transition: all 0.15s ease;
      text-align: center;
    }
    .webclaw-sleep-wake-btn:hover {
      background: rgba(250, 204, 21, 0.12);
      border-color: rgba(250, 204, 21, 0.3);
      color: #facc15;
    }
    .webclaw-sleep-wake-btn:active {
      transform: scale(0.97);
    }

    /* Sleep result banner */
    .webclaw-sleep-result {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 10px;
      margin-bottom: 8px;
      background: rgba(250, 204, 21, 0.08);
      border: 1px solid rgba(250, 204, 21, 0.2);
      border-radius: 8px;
      animation: wc-sleep-result-in 0.4s ease-out;
    }
    @keyframes wc-sleep-result-in {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .webclaw-sleep-result-icon {
      font-size: 16px;
    }
    .webclaw-sleep-result-text {
      font-size: 11px;
      color: #fde68a;
      line-height: 1.4;
    }
  `;

  document.head.appendChild(style);
  document.body.appendChild(overlay);

  // ============================================================
  // DOM REFERENCES
  // ============================================================

  const $ = (id) => document.getElementById(id);
  const statusEl     = $('webclaw-status');
  const modelEl      = $('webclaw-model');
  const stepEl       = $('webclaw-step');
  const metaEl       = $('webclaw-meta');
  const phaseBadge   = $('webclaw-phase-badge');
  const tokensEl     = $('webclaw-tokens');
  const infraEl      = $('webclaw-infra');
  const infraText    = $('webclaw-infra-text');
  const thinkingEl   = $('webclaw-thinking');
  const thoughtEl    = $('webclaw-thought');
  const thoughtText  = $('webclaw-thought-text');
  const actionEl     = $('webclaw-action');
  const actionText   = $('webclaw-action-text');
  const obsEl        = $('webclaw-observation');
  const obsText      = $('webclaw-observation-text');
  const emptyEl      = $('webclaw-empty');
  const phaseDots    = document.querySelectorAll('.webclaw-phase-dot');
  // Sleep panel refs
  const sleepPanel     = $('webclaw-sleep-panel');
  const sleepIcon      = $('webclaw-sleep-icon');
  const sleepTitle     = $('webclaw-sleep-title');
  const sleepTimer     = $('webclaw-sleep-timer');
  const sleepReasonEl  = $('webclaw-sleep-reason');
  const sleepCondition = $('webclaw-sleep-condition');
  const sleepBarFill   = $('webclaw-sleep-bar-fill');
  const sleepWakeBtn   = $('webclaw-sleep-wake-btn');
  const sleepResult    = $('webclaw-sleep-result');
  const sleepResultIcon = $('webclaw-sleep-result-icon');
  const sleepResultText = $('webclaw-sleep-result-text');

  // ============================================================
  // PHASE HELPERS
  // ============================================================

  const PHASE_ORDER = ['planning', 'extracting', 'filtering', 'confirming', 'executing'];
  const PHASE_LABELS = {
    planning:    '📋 Планирование',
    extracting:  '🔍 Извлечение',
    filtering:   '🔎 Фильтрация',
    confirming:  '⚠️ Подтверждение',
    executing:   '⚡ Выполнение',
    done:        '✔ Завершено',
    idle:        ''
  };

  function updatePhaseBar(phase) {
    const idx = PHASE_ORDER.indexOf(phase);
    phaseDots.forEach((dot, i) => {
      dot.classList.remove('done', 'current');
      if (idx < 0) return; // idle or unknown
      if (i < idx) dot.classList.add('done');
      else if (i === idx) dot.classList.add('current');
    });
  }

  // ============================================================
  // UI UPDATE FUNCTIONS
  // ============================================================

  function showEmpty() {
    emptyEl.style.display = '';
    metaEl.style.display = 'none';
    infraEl.style.display = 'none';
    thinkingEl.style.display = 'none';
    thoughtEl.style.display = 'none';
    actionEl.style.display = 'none';
    obsEl.style.display = 'none';
  }

  function hideEmpty() {
    emptyEl.style.display = 'none';
    metaEl.style.display = '';
  }

  function updateStatus(text, mode) {
    statusEl.textContent = text;
    statusEl.className = 'webclaw-status ' + (mode || '');
  }

  function updateStep(step) {
    stepEl.textContent = step > 0 ? `Шаг ${step}` : '';
  }

  function updateModel(name) {
    if (name) {
      // Show short model name (e.g., "gpt-4o" from "openai/gpt-4o")
      const short = name.includes('/') ? name.split('/').pop() : name;
      modelEl.textContent = short.slice(0, 20);
      modelEl.title = name; // full name on hover
      modelEl.style.display = '';
    } else {
      modelEl.style.display = 'none';
    }
  }

  function updateTokens() {
    if (totalTokens > 0) {
      const limit = tokenLimit > 0 ? ` / ${Math.round(tokenLimit / 1000)}k` : '';
      tokensEl.textContent = `🪙 ${totalTokens.toLocaleString()}${limit}`;
    } else {
      tokensEl.textContent = '';
    }
  }

  function updatePhase(phase) {
    currentPhase = phase;
    const label = PHASE_LABELS[phase] || phase || '';
    if (label) {
      phaseBadge.textContent = label;
      phaseBadge.style.display = '';
    } else {
      phaseBadge.style.display = 'none';
    }
    updatePhaseBar(phase);
  }

  function updateInfra(text) {
    if (text) {
      lastInfraText = text;
      infraText.textContent = text;
      infraEl.style.display = '';
      // Auto-hide infra after 4 seconds (it's transient)
      clearTimeout(updateInfra._timer);
      updateInfra._timer = setTimeout(() => {
        infraEl.style.display = 'none';
      }, 4000);
    } else {
      infraEl.style.display = 'none';
    }
  }

  function updateThinking(isThinking) {
    modelThinking = isThinking;
    thinkingEl.style.display = isThinking ? '' : 'none';
  }

  function updateThought(text) {
    if (text) {
      thoughtText.textContent = text;
      thoughtEl.style.display = '';
    } else {
      thoughtEl.style.display = 'none';
    }
  }

  function updateAction(text) {
    if (text) {
      actionText.textContent = text;
      actionEl.style.display = '';
    } else {
      actionEl.style.display = 'none';
    }
  }

  function updateObservation(text, isError) {
    if (text) {
      obsText.textContent = text;
      obsText.classList.toggle('error', !!isError);
      obsEl.style.display = '';
    } else {
      obsEl.style.display = 'none';
    }
  }

  // ============================================================
  // SHOW / HIDE WIDGET
  // ============================================================

  const STORAGE_KEY = 'webclaw_widget_hidden';

  function hideWidget() {
    widgetDismissed = true;
    overlay.style.display = 'none';
    try { chrome.storage.local.set({ [STORAGE_KEY]: true }); } catch (_) {}
  }

  function showWidget() {
    widgetDismissed = false;
    overlay.style.display = '';
    try { chrome.storage.local.set({ [STORAGE_KEY]: false }); } catch (_) {}
  }

  // ============================================================
  // SLEEP PANEL — show/hide, timer, wake button
  // ============================================================

  function formatSleepTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return m + ':' + String(s).padStart(2, '0');
  }

  function showSleepPanel(mode, reason, maxDurationSec, startedAt) {
    isSleeping = true;
    sleepMode = mode;
    sleepReason = reason;
    sleepMaxDurationSec = maxDurationSec;
    sleepStartedAt = startedAt || Date.now();
    sleepElapsedSec = 0;

    // Hide normal activity panels
    thoughtEl.style.display = 'none';
    actionEl.style.display = 'none';
    obsEl.style.display = 'none';
    infraEl.style.display = 'none';
    thinkingEl.style.display = 'none';

    // Configure panel mode
    sleepPanel.className = 'webclaw-sleep-panel ' + (mode === 'deep_sleep' ? 'deep-sleep' : 'watchful');
    hideEmpty();

    if (mode === 'deep_sleep') {
      sleepIcon.textContent = '🌙';
      sleepTitle.textContent = 'Глубокая спячка';
      sleepCondition.textContent = 'Экран игнорируется. Экономия ресурсов.';
    } else {
      sleepIcon.textContent = '👁️';
      sleepTitle.textContent = 'Наблюдение';
      sleepCondition.textContent = 'Сканирую экран. Разбудит любое изменение.';
    }

    sleepReasonEl.textContent = reason || '';
    sleepTimer.textContent = '0:00';
    sleepBarFill.style.width = '0%';

    // Show the panel
    sleepPanel.style.display = '';
    sleepResult.style.display = 'none';

    // Update status bar
    updateStatus(mode === 'deep_sleep' ? '🌙 Спячка' : '👁️ Наблюдение', 'running');

    // Start local countdown timer
    if (sleepTimerInterval) clearInterval(sleepTimerInterval);
    sleepTimerInterval = setInterval(() => {
      sleepElapsedSec = Math.round((Date.now() - sleepStartedAt) / 1000);
      sleepTimer.textContent = formatSleepTime(sleepElapsedSec);

      // Progress bar (percentage of max duration)
      if (sleepMaxDurationSec > 0) {
        const pct = Math.min(100, Math.round((sleepElapsedSec / sleepMaxDurationSec) * 100));
        sleepBarFill.style.width = pct + '%';
      }
    }, 1000);
  }

  function hideSleepPanel(wakeReason, elapsedSec) {
    isSleeping = false;
    if (sleepTimerInterval) { clearInterval(sleepTimerInterval); sleepTimerInterval = null; }
    sleepPanel.style.display = 'none';

    // Show brief result banner
    if (wakeReason) {
      const reasonLabels = {
        'visual_change_detected': '🔔 Обнаружено изменение экрана',
        'timeout': '⏰ Время ожидания истекло',
        'forced_by_user': '⚡ Пробуждено вручную',
        'user_aborted': '⏹ Остановлено пользователем'
      };
      const label = reasonLabels[wakeReason] || `🔔 Пробуждено: ${wakeReason}`;
      const timeText = elapsedSec ? ` (через ${formatSleepTime(elapsedSec)})` : '';
      sleepResultIcon.textContent = wakeReason === 'forced_by_user' ? '⚡' : '🔔';
      sleepResultText.textContent = label + timeText;
      sleepResult.style.display = '';

      // Auto-hide result banner after 8 seconds
      clearTimeout(hideSleepPanel._resultTimer);
      hideSleepPanel._resultTimer = setTimeout(() => {
        sleepResult.style.display = 'none';
      }, 8000);
    }

    // Restore normal activity UI
    updateStatus('Работает', 'running');
  }

  // ============================================================
  // RESET to idle state
  // ============================================================

  function resetToIdle() {
    agentRunning = false;
    agentPaused = false;
    currentStep = 0;
    currentPhase = 'idle';
    totalTokens = 0;
    modelName = '';
    currentThought = '';
    currentAction = '';
    currentObservation = '';
    lastInfraText = '';
    modelThinking = false;

    updateStatus('Ожидание', '');
    updateStep(0);
    updateModel('');
    updatePhase('idle');
    updateTokens();
    updateThinking(false);
    updateThought('');
    updateAction('');
    updateObservation('');
    updateInfra('');
    showEmpty();
    // Reset sleep state
    isSleeping = false;
    if (sleepTimerInterval) { clearInterval(sleepTimerInterval); sleepTimerInterval = null; }
    if (sleepPanel) sleepPanel.style.display = 'none';
    if (sleepResult) sleepResult.style.display = 'none';
    // Auto-hide widget when agent is idle and user previously dismissed it
    hideWidget();
  }

  // ============================================================
  // FORMAT HELPERS (inline, no imports needed for content script)
  // ============================================================

  function formatAction(action) {
    if (!action) return '';
    const a = typeof action === 'string' ? (() => { try { return JSON.parse(action); } catch (_) { return { action: action }; } })() : action;
    const tool = a.tool || a.action || '?';
    const params = [];
    if (a.selector) params.push(a.selector);
    if (a.text) params.push(`"${a.text.slice(0, 40)}"`);
    if (a.direction) params.push(a.direction);
    if (a.url) params.push(a.url.slice(0, 50));
    if (a.x !== undefined && a.y !== undefined) params.push(`(${a.x},${a.y})`);
    if (a.key) params.push(a.key);
    if (a.value) params.push(a.value);
    if (a.amount) params.push(`${a.amount}px`);
    const paramStr = params.length > 0 ? ': ' + params.join(', ') : '';
    return `${tool}${paramStr}`;
  }

  function formatObservation(obs) {
    if (!obs) return '';
    const o = typeof obs === 'string' ? (() => { try { return JSON.parse(obs); } catch (_) { return { ok: obs }; } })() : obs;
    if (o.ok === false || o.error) return `❌ ${o.error || 'ошибка'}`;
    if (o.ok === true) {
      if (o.text) return `✅ "${o.text.slice(0, 50)}"`;
      if (o.value) return `✅ ${String(o.value).slice(0, 60)}`;
      if (o.scrollY !== undefined) return `✅ scrollY=${o.scrollY}`;
      if (o.selected) return `✅ ${o.selected}`;
      if (o.fileName) return `✅ ${o.fileName}`;
      return '✅ OK';
    }
    return JSON.stringify(o).slice(0, 80);
  }

  // ============================================================
  // MESSAGE LISTENER
  // ============================================================

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg._agentEvent) return;

    switch (msg.kind) {

      // ---- Agent lifecycle ----

      case 'started':
        agentRunning = true;
        agentPaused = false;
        currentStep = 0;
        currentPhase = 'idle';
        totalTokens = 0;
        modelName = msg.model || '';
        tokenLimit = msg.tokenLimit || 0;
        modelThinking = false;
        showWidget();
        hideEmpty();
        updateStatus('Работает', 'running');
        updateModel(modelName);
        updateStep(0);
        updateTokens();
        updatePhase('idle');
        updateThinking(false);
        updateThought('');
        updateAction('');
        updateObservation('');
        break;

      case 'finished':
        agentRunning = false;
        agentPaused = false;
        modelThinking = false;
        updateThinking(false);
        if (msg.ok) {
          updateStatus('✔ Готово', 'done');
        } else {
          updateStatus('✖ Остановлено', 'error');
        }
        updatePhase('done');
        // Keep the last thought/action/observation visible for a longer time
        // Then after 15 seconds, reset to idle
        clearTimeout(resetToIdle._finishTimer);
        resetToIdle._finishTimer = setTimeout(() => {
          resetToIdle();
        }, 15000);
        break;

      // ---- Pause / Resume ----

      case 'paused':
        agentPaused = true;
        updateStatus('⏸ Пауза', 'paused');
        break;

      case 'resume':
        agentPaused = false;
        updateStatus('Работает', 'running');
        break;

      // ---- Step progress ----

      case 'step_start':
        currentStep = msg.step;
        updateStep(msg.step);
        // Do NOT clear thought/action/observation here — they persist from
        // the previous step until new ones arrive. This prevents flickering
        // between steps.
        break;

      // ---- Phase changes ----

      case 'phase_changed':
        updatePhase(msg.phase);
        break;

      // ---- Plan ----

      case 'plan_ready':
        if (msg.plan?.type === 'batch') {
          updateInfra(`📋 Пакетный план: ${msg.plan.goal || ''}`);
        } else {
          updateInfra('📋 Простой режим');
        }
        break;

      // ---- Model calls ----

      case 'model_call_start':
        updateThinking(true);
        updateInfra('🧠 Модель думает...');
        break;

      case 'model_call_end':
        updateThinking(false);
        if (msg.error) {
          updateInfra(`❌ Ошибка модели: ${msg.error}`);
        } else {
          const dur = msg.duration ? `${(msg.duration / 1000).toFixed(1)}с` : '';
          const tok = msg.tokensUsed ? ` · 🪙${msg.tokensUsed}` : '';
          updateInfra(`✅ Ответ за ${dur}${tok}`);
        }
        break;

      // ---- Tokens ----

      case 'tokens_update':
        totalTokens = msg.totalTokensUsed || totalTokens;
        updateTokens();
        break;

      // ---- AI Thought ----

      case 'agent_thought':
        currentThought = msg.thought || '';
        updateThought(currentThought);
        break;

      // ---- Action ----

      case 'action':
        currentAction = msg.action ? formatAction(msg.action) : '';
        updateAction(currentAction);
        break;

      // ---- Observation ----

      case 'observation':
        if (msg.observation) {
          const isError = msg.observation.ok === false || !!msg.observation.error;
          currentObservation = formatObservation(msg.observation);
          updateObservation(currentObservation, isError);
        }
        break;

      // ---- Infrastructure messages ----

      case 'infra':
        updateInfra(msg.text || '');
        break;

      case 'screenshot_captured':
        // Brief flash — handled by infra text
        break;

      // ---- Batch progress ----

      case 'batch_started':
        updateInfra(`🔄 Пакет: ${msg.total} элементов`);
        break;

      case 'batch_progress':
        if (msg.total) {
          const pct = Math.round(((msg.current || 0) / msg.total) * 100);
          updateInfra(`🔄 ${msg.current}/${msg.total} (${pct}%) ✅${msg.succeeded || 0} ❌${msg.failed || 0}`);
        }
        break;

      case 'batch_finished':
        if (msg.report) {
          const r = msg.report;
          updateInfra(`📊 Пакет: ${r.succeeded || 0}/${r.total || 0} ок`);
        }
        break;

      // ---- Confirmation ----

      case 'confirmation_required':
        updateInfra(`⚠ Требуется подтверждение: ${(msg.items || []).length} элементов`);
        break;

      case 'paused_for_confirmation':
        agentPaused = true;
        updateStatus('⏸ Подтверждение', 'paused');
        updateInfra('⏸ Ожидаем вашего подтверждения');
        break;

      // ---- Resume after SW restart ----

      case 'resumed_after_interrupt':
        agentRunning = true;
        agentPaused = false;
        currentStep = msg.step || 0;
        showWidget();
        hideEmpty();
        updateStatus('⚡ Возобновлено', 'running');
        updateStep(currentStep);
        if (msg.phase) updatePhase(msg.phase);
        // Restore model name from message or previously stored value
        if (msg.model) modelName = msg.model;
        if (modelName) updateModel(modelName);
        break;

      // ---- API call logging ----

      case 'api_call':
        // Don't show in overlay — too noisy
        break;

      // ---- Log messages (from background) ----

      case 'log':
        // Show error logs briefly in infra
        if (msg.level === 'error') {
          updateInfra(`❌ ${msg.text || ''}`);
        }
        break;

      // ---- Sleep mode ----

      case 'sleep_started':
        showSleepPanel(msg.mode, msg.reason, msg.maxDurationSec, msg.startedAt);
        break;

      case 'sleep_ended':
        hideSleepPanel(msg.wakeReason, msg.elapsedSec);
        break;

      case 'force_wake':
        // If panel is still visible (e.g., for watchful), hide it
        if (isSleeping) {
          hideSleepPanel('forced_by_user', sleepElapsedSec);
        }
        break;

      // ---- Widget visibility toggle (from popup) ----

      case 'toggle_widget':
      case 'toggle_widget_visibility':
        if (widgetDismissed || overlay.style.display === 'none') {
          showWidget();
          // If agent is idle, still show the widget briefly with empty state
          if (!agentRunning) {
            showEmpty();
            // Auto-hide after 8 seconds if agent is not running
            clearTimeout(widgetAutoHideTimer);
            widgetAutoHideTimer = setTimeout(() => {
              if (!agentRunning) hideWidget();
            }, 8000);
          }
        } else {
          hideWidget();
        }
        break;
    }

    return true;
  });

  // ============================================================
  // CLICK HANDLERS (open monitoring page)
  // ============================================================

  const header = $('webclaw-header');
  const footer = $('webclaw-footer');
  const closeBtn = $('webclaw-close');

  function openMonitoringPage() {
    // Content scripts cannot use chrome.tabs.create or chrome.sidePanel.open directly.
    // Send a message to the background script to open the monitoring page.
    chrome.runtime.sendMessage({ kind: 'openSidePanel' }).catch(() => {
      // Fallback: try the logs page via background
      chrome.runtime.sendMessage({ kind: 'openLogs' }).catch(() => {});
    });
  }

  if (header) header.addEventListener('click', openMonitoringPage);
  if (footer) footer.addEventListener('click', openMonitoringPage);

  // Close button — hide widget (stop propagation so header click doesn't fire)
  if (closeBtn) {
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideWidget();
    });
  }

  // Sleep wake button — force wake the agent
  if (sleepWakeBtn) {
    sleepWakeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ kind: 'force_wake' }).catch(() => {});
      // Optimistic UI: disable button while request is in flight
      sleepWakeBtn.textContent = '⚡ Пробуждение...';
      sleepWakeBtn.disabled = true;
      setTimeout(() => {
        sleepWakeBtn.textContent = '⚡ Разбудить сейчас';
        sleepWakeBtn.disabled = false;
      }, 3000);
    });
  }

  // ============================================================
  // INIT: check if agent is already running (for pages loaded after agent started)
  // ============================================================

  (async () => {
    // Always start hidden — will show only if agent is running
    overlay.style.display = 'none';

    try {
      const resp = await chrome.runtime.sendMessage({ kind: 'status' });
      if (resp && resp.running) {
        agentRunning = true;
        agentPaused = resp.paused || false;
        currentStep = resp.step || 0;
        currentPhase = resp.phase || 'idle';
        if (resp.totalTokensUsed) totalTokens = resp.totalTokensUsed;
        // Restore model name if available
        if (resp.model) modelName = resp.model;
        hideEmpty();
        showWidget();
        updateStatus(agentPaused ? '⏸ Пауза' : 'Работает', agentPaused ? 'paused' : 'running');
        updateStep(currentStep);
        updateModel(modelName);
        updatePhase(currentPhase);
        updateTokens();
        // Restore sleep state if agent is sleeping
        if (resp.currentSleep) {
          showSleepPanel(resp.currentSleep.mode, resp.currentSleep.reason, resp.currentSleep.maxDurationSec, resp.currentSleep.startedAt);
        }
      }
      // Also fetch log buffer to restore last known state (thoughts, actions, tokens)
      try {
        const logsResp = await chrome.runtime.sendMessage({ kind: 'get_status_and_logs' });
        if (logsResp) {
          if (logsResp.status?.totalTokensUsed) {
            totalTokens = logsResp.status.totalTokensUsed;
            updateTokens();
          }
          // Replay recent events to restore widget state
          const buffer = logsResp.logBuffer || [];
          for (const evt of buffer.slice(-20)) { // last 20 events
            if (evt.kind === 'agent_thought' && evt.thought) {
              currentThought = evt.thought;
              updateThought(currentThought);
            } else if (evt.kind === 'action' && evt.action) {
              currentAction = formatAction(evt.action);
              updateAction(currentAction);
            } else if (evt.kind === 'observation' && evt.observation) {
              const isError = evt.observation.ok === false || !!evt.observation.error;
              currentObservation = formatObservation(evt.observation);
              updateObservation(currentObservation, isError);
            } else if (evt.kind === 'tokens_update' && evt.totalTokensUsed) {
              totalTokens = evt.totalTokensUsed;
              updateTokens();
            }
          }
        }
      } catch (_) {}
    } catch (_) {
      // background not available — that's fine, widget stays hidden
    }
  })();

})();

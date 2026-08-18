// sidepanel.js — Agent Monitor Side Panel
//
// Rich timeline view showing:
//   - AI thinking/reasoning per step
//   - Actions taken with visual badges
//   - Observations/results
//   - Screenshot thumbnails (click to expand)
//   - Model call timing
//   - Token usage sparkline
//   - Phase tracking
//   - Controls: pause/stop

import { formatActionHuman, formatObservationHuman, formatThought } from './format_helper.js';

const $ = (id) => document.getElementById(id);

// DOM refs
const dot = $('dot');
const statStep = $('stat-step');
const statTokens = $('stat-tokens');
const statThinking = $('stat-thinking');
const statThinkingTime = $('stat-thinking-time');
const taskDisplay = $('task-display');
const btnPause = $('btn-pause');
const btnStop = $('btn-stop');
const tokenChart = $('token-chart');
const timeline = $('timeline');
const emptyState = $('empty-state');
const lightbox = $('lightbox');
const lightboxImg = $('lightbox-img');
const navMapToggle = $('nav-map-toggle');
const navMapContainer = $('nav-map-container');
const navTree = $('nav-tree');
const navCount = $('nav-count');
const navMapEmpty = $('nav-map-empty');

// ============================================================
// HELPERS
// ============================================================

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function getActionType(action) {
  if (!action) return '';
  return action._isChain
    ? 'action_chain'
    : (action.tool || action.action || action.type || '');
}

function getActionClass(actionOrType) {
  const actionType = typeof actionOrType === 'string' ? actionOrType : getActionType(actionOrType);
  const known = ['click_at', 'right_click_at', 'type_at', 'paste_text', 'type_code', 'set_value_via_api',
    'scroll', 'scroll_at', 'navigate', 'done', 'fail', 'wait', 'press_key', 'hover_at', 'select_at',
    'checkbox_at', 'back', 'forward', 'reload', 'jump_to_node', 'mark_node', 'swipe', 'remember', 'recall'];

  if (actionType === 'action_chain') return 'chain';
  if (actionType === 'thinking') return 'thinking';
  if (!known.includes(actionType)) return 'other';

  return actionType
    .replace('_at', '')
    .replace('right_click', 'click')
    .replace('paste_text', 'type')
    .replace('type_code', 'type')
    .replace('set_value_via_api', 'type')
    .replace('press_key', 'type')
    .replace('checkbox', 'click')
    .replace('swipe', 'scroll')
    .replace('remember', 'other')
    .replace('recall', 'other');
}

function observationHasError(obs) {
  if (!obs) return false;
  if (obs.ok === false || obs.error) return true;
  if (Array.isArray(obs.results)) return obs.results.some(r => r?.ok === false || r?.error);
  return false;
}

function shortModelName(modelId) {
  if (!modelId) return '';
  const parts = modelId.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : modelId;
}

function renderActionBadge(action, opts = {}) {
  const label = formatActionHuman(action);
  const prefix = opts.prefix ? `<span style="opacity:.65;min-width:24px">${escapeHtml(opts.prefix)}</span>` : '';
  const extra = opts.extra ? `<span style="margin-left:auto;color:#6b7280;font-size:10px">${escapeHtml(opts.extra)}</span>` : '';
  return `
    <div class="observation-badge ok event-block event-action">
      ${prefix}<span>${escapeHtml(label)}</span>${extra}
    </div>`;
}

function renderChainActions(action) {
  if (!action?._isChain || !Array.isArray(action.actions) || action.actions.length === 0) return '';

  let html = `
    <div class="detail event-block event-action">
      <div class="detail-label">⛓️ Действия в цепочке (${action.actions.length})</div>`;

  action.actions.forEach((a, i) => {
    html += renderActionBadge(a, { prefix: `#${i + 1}` });
  });

  html += '</div>';
  return html;
}

function renderChainResults(observation) {
  if (!observation || observation.tool !== 'action_chain' || !Array.isArray(observation.results)) return '';

  let html = `
    <div class="detail event-block event-observation ${observationHasError(observation) ? 'event-error' : ''}">
      <div class="detail-label">✅ Результаты цепочки (${observation.executed || observation.results.length}/${observation.chainLength || observation.results.length})</div>`;

  observation.results.forEach((result, i) => {
    const ok = result?.ok !== false;
    const text = result?.error
      ? `Ошибка: ${result.error}`
      : formatObservationHuman(result);
    html += `
      <div class="observation-badge ${ok ? 'ok' : 'err'} ${ok ? '' : 'event-error'}">
        <span style="opacity:.65;min-width:24px">#${i + 1}</span>
        <span>${escapeHtml(text)}</span>
      </div>`;
  });

  html += '</div>';
  return html;
}

function updateStepFilterContent(el, stepData) {
  if (!el) return;

  const blocks = el.querySelectorAll('.event-block');
  if (activeFilter === 'all') {
    blocks.forEach(block => { block.style.display = ''; });
    el.style.display = '';
    return;
  }

  let visibleBlocks = 0;
  blocks.forEach(block => {
    const show = activeFilter === 'thought'
      ? block.classList.contains('event-thought')
      : activeFilter === 'action'
        ? block.classList.contains('event-action')
        : activeFilter === 'error'
          ? block.classList.contains('event-error')
          : true;
    block.style.display = show ? '' : 'none';
    if (show) visibleBlocks++;
  });

  el.style.display = visibleBlocks > 0 && isStepVisible(stepData) ? '' : 'none';
}

// State
let steps = new Map(); // step number → step data object
let running = false;
let paused = false;
let stepCount = 0;
let totalTokens = 0;
let currentPhase = 'idle';
let task = '';
let activeFilter = 'all';
let tokenHistory = []; // [{step, tokens}]
let thinkingStartTime = 0;
let thinkingTimer = null;
let navTreeData = null; // { nodeCount, currentNodeId, nodes: [] }
// Sleep state (for timeline sleep cards)
let isSleeping = false;
let sleepCardId = null; // ID of the active sleep card element
let sleepStartTime = 0;
let sleepTimerInterval = null;
let sleepMaxDurationSec = 0;
let sleepMode = '';

// ============================================================
// STATE HELPERS
// ============================================================

function getOrCreateStep(stepNum) {
  if (!steps.has(stepNum)) {
    steps.set(stepNum, {
      num: stepNum,
      thought: '',
      action: null,
      observation: null,
      screenshotUrl: null,
      modelDuration: 0,
      tokensUsed: 0,
      modelId: '',
      error: null,
      logLines: [],
      timestamp: new Date(),
      phase: currentPhase
    });
  }
  return steps.get(stepNum);
}

// ============================================================
// RENDERING
// ============================================================

function updateStats() {
  statStep.textContent = stepCount;
  statTokens.textContent = totalTokens > 0 ? totalTokens.toLocaleString() : '0';
  dot.className = 'dot ' + (running ? (paused ? 'paused' : 'working') : 'idle');

  // Thinking timer
  if (thinkingStartTime > 0) {
    statThinking.style.display = '';
    const elapsed = Math.round((Date.now() - thinkingStartTime) / 1000);
    statThinkingTime.textContent = elapsed + 'с';
  } else {
    statThinking.style.display = 'none';
  }
}

function updateControls() {
  if (running) {
    btnPause.style.display = '';
    btnStop.style.display = '';
    btnPause.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
  } else {
    btnPause.style.display = 'none';
    btnStop.style.display = 'none';
  }
}

function updateTaskDisplay() {
  if (task) {
    taskDisplay.textContent = task;
    taskDisplay.style.color = '#e6e8eb';
  } else {
    taskDisplay.textContent = 'Нет активной задачи';
    taskDisplay.style.color = '#6b7280';
  }
}

function updateTokenChart() {
  if (tokenHistory.length === 0) return;
  const maxTokens = Math.max(...tokenHistory.map(t => t.tokens), 1);

  tokenChart.innerHTML = '';
  const recent = tokenHistory.slice(-40); // last 40 steps
  for (const entry of recent) {
    const bar = document.createElement('div');
    bar.className = 'token-bar';
    const pct = Math.max(5, Math.round((entry.tokens / maxTokens) * 100));
    bar.style.height = pct + '%';
    bar.title = `Шаг ${entry.step}: ${entry.tokens} токенов`;
    tokenChart.appendChild(bar);
  }
}

// ============================================================
// SLEEP CARD RENDERING
// ============================================================

function formatSleepTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m + ':' + String(s).padStart(2, '0');
}

function renderSleepStartCard(mode, reason, maxDurationSec, startedAt) {
  isSleeping = true;
  sleepMode = mode;
  sleepStartTime = startedAt || Date.now();
  sleepMaxDurationSec = maxDurationSec;

  // Remove any previous sleep card
  if (sleepCardId) {
    const old = document.getElementById(sleepCardId);
    if (old) old.remove();
  }

  const cardId = 'sleep-card-' + Date.now();
  sleepCardId = cardId;

  const isWatchful = mode !== 'deep_sleep';
  const icon = isWatchful ? '👁️' : '🌙';
  const badgeClass = isWatchful ? 'watchful-sleep' : 'deep-sleep';
  const badgeText = isWatchful ? '👁️ WATCH' : '🌙 DEEP SLEEP';
  const title = isWatchful ? 'Агент перешел в режим наблюдения' : 'Агент перешел в глубокую спячку';
  const color = isWatchful ? '#38bdf8' : '#818cf8';
  const bgColor = isWatchful ? 'rgba(56, 189, 248, 0.08)' : 'rgba(99, 102, 241, 0.08)';
  const borderColor = isWatchful ? 'rgba(56, 189, 248, 0.3)' : 'rgba(99, 102, 241, 0.3)';
  const condition = isWatchful
    ? 'Сканирование экрана включено. Проснется при изменениях.'
    : 'Экран игнорируется. Экономия ресурсов.';

  const card = document.createElement('div');
  card.id = cardId;
  card.className = 'step-card sleep-card';
  card.style.borderColor = borderColor;
  card.style.background = bgColor;
  card.innerHTML = `
    <div class="step-header" onclick="toggleStep('${cardId}')" style="cursor:pointer;flex-direction:row;align-items:center;gap:6px">
      <span style="font-size:18px">${icon}</span>
      <span class="step-action-badge ${badgeClass}">${badgeText}</span>
      <span class="sleep-card-timer" id="sleep-card-timer" style="font-size:12px;font-weight:700;font-variant-numeric:tabular-nums;color:${color}">0:00</span>
    </div>
    <div class="step-body open" id="step-body-${cardId}">
      <div class="observation-badge ok" style="background:${bgColor};border-color:${borderColor};color:${color}">
        <strong style="color:${color}">${escapeHtml(title)}</strong><br>
        <span style="color:#9ca3af;font-size:11px">
          <strong>Причина:</strong> ${escapeHtml(reason || '—')}<br>
          <strong>Условие:</strong> ${escapeHtml(condition)}<br>
          <strong>Таймер:</strong> ${formatSleepTime(maxDurationSec || 0)} макс.
        </span>
      </div>
      <button class="sleep-wake-btn" onclick="window._forceWakeFromSidepanel()" style="
        display:block;width:100%;padding:8px 0;margin-top:8px;
        font-size:11px;font-weight:600;color:#e6e8eb;
        background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);
        border-radius:6px;cursor:pointer;text-align:center;
        transition:all 0.15s ease;
      ">⚡ Разбудить сейчас</button>
    </div>
  `;

  timeline.appendChild(card);
  timeline.scrollTop = timeline.scrollHeight;

  // Local countdown timer
  if (sleepTimerInterval) clearInterval(sleepTimerInterval);
  sleepTimerInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - sleepStartTime) / 1000);
    const timerEl = document.getElementById('sleep-card-timer');
    if (timerEl) timerEl.textContent = formatSleepTime(elapsed);
  }, 1000);
}

function renderSleepEndCard(wakeReason, elapsedSec) {
  isSleeping = false;
  if (sleepTimerInterval) { clearInterval(sleepTimerInterval); sleepTimerInterval = null; }

  const reasonLabels = {
    'visual_change_detected': '🔔 Обнаружено изменение экрана',
    'timeout': '⏰ Время ожидания истекло',
    'forced_by_user': '⚡ Пробуждено вручную',
    'user_aborted': '⏹ Остановлено пользователем'
  };
  const label = reasonLabels[wakeReason] || `🔔 Пробуждено: ${wakeReason}`;
  const timeText = elapsedSec ? ` (через ${formatSleepTime(elapsedSec)})` : '';

  const isForced = wakeReason === 'forced_by_user';
  const icon = isForced ? '⚡' : '🔔';
  const badgeClass = isForced ? 'wake-forced' : 'wake-up';
  const badgeText = isForced ? '⚡ WAKE UP' : '🔔 WAKE UP';
  const borderColor = isForced ? 'rgba(250, 204, 21, 0.4)' : 'rgba(34, 197, 94, 0.4)';
  const bgColor = isForced ? 'rgba(250, 204, 21, 0.06)' : 'rgba(34, 197, 94, 0.06)';
  const textColor = isForced ? '#fde68a' : '#86efac';

  const card = document.createElement('div');
  card.className = 'step-card wake-card';
  card.style.borderColor = borderColor;
  card.style.background = bgColor;
  card.innerHTML = `
    <div class="step-header" style="flex-direction:row;align-items:center;gap:6px">
      <span style="font-size:18px">${icon}</span>
      <span class="step-action-badge ${badgeClass}">${badgeText}</span>
      <span style="flex:1;font-size:12px;color:${textColor}">${escapeHtml(label)}${timeText}</span>
    </div>
  `;

  timeline.appendChild(card);
  timeline.scrollTop = timeline.scrollHeight;
}

// Global force-wake handler (called from inline onclick)
window._forceWakeFromSidepanel = async function() {
  // Optimistic UI: disable the button
  const btn = document.querySelector('.sleep-wake-btn');
  if (btn) {
    btn.textContent = '⚡ Пробуждение...';
    btn.disabled = true;
    btn.style.opacity = '0.5';
  }
  try {
    const r = await chrome.runtime.sendMessage({ kind: 'force_wake' });
    if (!r?.ok) {
      console.warn('[sidepanel] force_wake failed:', r?.error);
      // Re-enable button on failure
      if (btn) {
        btn.textContent = '⚡ Разбудить сейчас';
        btn.disabled = false;
        btn.style.opacity = '1';
      }
    }
    // On success: UI will update via broadcast events (sleep_ended, force_wake)
  } catch (e) {
    console.error('[sidepanel] force_wake error:', e.message);
    // Re-enable button on error
    if (btn) {
      btn.textContent = '⚡ Разбудить сейчас';
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  }
};

function renderStep(stepData) {
  const num = stepData.num;
  const existingEl = document.getElementById(`step-${num}`);

  // Build step card HTML with human-readable formatting
  const hasError = !!stepData.error || observationHasError(stepData.observation);
  const humanAction = stepData.action ? formatActionHuman(stepData.action) : (stepData.thought ? '💭 Рассуждение' : '⏳ В процессе');
  const actionType = stepData.action ? getActionType(stepData.action) : (stepData.thought ? 'thinking' : 'unknown');
  const actionClass = getActionClass(actionType);

  const time = stepData.timestamp.toLocaleTimeString();

  let html = `
    <div class="step-header" onclick="toggleStep(${num})">
      <div class="step-header-row-1">
        <span class="step-num">#${num}</span>
        <span class="step-action-badge ${actionClass}">${escapeHtml(humanAction.slice(0, 50))}</span>
        <span class="step-time">${time}</span>
      </div>
      <div class="step-header-row-2">
        ${stepData.modelId ? `<span class="model-badge" title="${escapeHtml(stepData.modelId)}">🤖 ${escapeHtml(shortModelName(stepData.modelId))}</span>` : ''}
        ${stepData.modelDuration > 0 ? `<span class="step-duration">${(stepData.modelDuration / 1000).toFixed(1)}с</span>` : ''}
        ${stepData.tokensUsed > 0 ? `<span style="font-size:10px;color:#6b7280">🪙${stepData.tokensUsed}</span>` : ''}
      </div>
    </div>
    <div class="step-body" id="step-body-${num}">`;

  // Thought block with beautiful styling
  if (stepData.thought) {
    html += `
      <div class="thought-block event-block event-thought">
        <div class="thought-title">💭 Ход мыслей ИИ:</div>
        <div class="thought-content">${escapeHtml(formatThought(stepData.thought))}</div>
      </div>`;
  }

  // Human-readable action summary
  if (stepData.action) {
    html += `
      <div class="observation-badge ${hasError ? 'err' : 'ok'} event-block event-action ${hasError ? 'event-error' : ''}">
        ${escapeHtml(humanAction)}
      </div>`;

    html += renderChainActions(stepData.action);
    
    // Raw JSON hidden in details spoiler
    const actionJson = JSON.stringify(stepData.action, null, 2);
    html += `
      <details class="detail event-block event-action">
        <summary class="detail-label" style="cursor:pointer">📋 Технические детали</summary>
        <pre>${escapeHtml(actionJson)}</pre>
      </details>`;
  }

  // Observation result
  if (stepData.observation) {
    const obsOk = stepData.observation.ok !== false;
    const humanObs = formatObservationHuman(stepData.observation);
    html += renderChainResults(stepData.observation);
    html += `
      <div class="observation-badge ${obsOk ? 'ok' : 'err'} event-block event-observation ${obsOk ? '' : 'event-error'}">
        ${escapeHtml(humanObs)}
      </div>`;
  }

  // Error
  if (stepData.error) {
    html += `<div class="observation-badge err event-block event-error">❌ ${escapeHtml(stepData.error)}</div>`;
  }

  // Log lines
  if (stepData.logLines.length > 0) {
    html += `
      <details class="detail event-block event-log">
        <summary class="detail-label" style="cursor:pointer">📋 Логи шага (${stepData.logLines.length})</summary>
        <pre>${stepData.logLines.map(l => escapeHtml(l)).join('\n')}</pre>
      </details>`;
  }

  // Screenshot thumbnail
  if (stepData.screenshotUrl) {
    html += `
      <div class="screenshot-thumb" onclick="openLightbox('${escapeHtml(stepData.screenshotUrl)}')">
        <img src="${escapeHtml(stepData.screenshotUrl)}" alt="Step ${num}" loading="lazy" />
      </div>`;
  }

  html += '</div>';

  if (existingEl) {
    existingEl.innerHTML = html;
    existingEl.className = `step-card${hasError ? ' has-error' : ''}`;
    updateStepFilterContent(existingEl, stepData);
  } else {
    const card = document.createElement('div');
    card.id = `step-${num}`;
    card.className = `step-card${hasError ? ' has-error' : ''}`;
    card.innerHTML = html;
    timeline.appendChild(card);

    // Hide empty state
    if (emptyState) emptyState.style.display = 'none';

    // Auto-expand last 2 steps
    const body = card.querySelector('.step-body');
    if (body && steps.size <= 3) {
      body.classList.add('open');
    }

    updateStepFilterContent(card, stepData);

    // Auto-scroll to latest
    timeline.scrollTop = timeline.scrollHeight;
  }
}

function isStepVisible(stepData) {
  if (activeFilter === 'all') return true;
  if (activeFilter === 'thought') return !!stepData.thought;
  if (activeFilter === 'action') return !!stepData.action && getActionType(stepData.action) !== 'thinking';
  if (activeFilter === 'error') return !!stepData.error || observationHasError(stepData.observation);
  return true;
}

function applyFilter(filter) {
  activeFilter = filter;
  // Update filter buttons
  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === filter);
  });
  // Show/hide relevant blocks inside steps
  for (const [num, stepData] of steps) {
    const el = document.getElementById(`step-${num}`);
    if (el) {
      updateStepFilterContent(el, stepData);
    }
  }
}

// ============================================================
// GLOBAL FUNCTIONS (called from HTML onclick)
// ============================================================

window.toggleStep = function(num) {
  const body = document.getElementById(`step-body-${num}`);
  if (body) body.classList.toggle('open');
};

window.openLightbox = function(src) {
  lightboxImg.src = src;
  lightbox.classList.add('active');
};

window.toggleNavMap = function() {
  const isOpen = navMapContainer.classList.toggle('open');
  navMapToggle.classList.toggle('expanded', isOpen);
  navMapToggle.querySelector('.arrow').textContent = isOpen ? '▼' : '▶';
};

// ============================================================
// NAVIGATION MAP RENDERING
// ============================================================

function updateNavMap(data) {
  if (!data) return;
  navTreeData = data;

  const nodes = data.nodes || [];
  const count = nodes.length;

  // Show/hide toggle
  if (count === 0) {
    navMapToggle.style.display = 'none';
    navMapContainer.classList.remove('open');
    return;
  }
  navMapToggle.style.display = '';
  navCount.textContent = count;

  // Build tree HTML
  if (navMapEmpty) navMapEmpty.style.display = 'none';

  const statusIcons = {
    'active': '📍', 'explored': '✅', 'promising': '🔮', 'dead_end': '❌'
  };
  const typeIcons = {
    'HUB': '🌐', 'LEAF': '📄'
  };

  // Build parent→children map
  const childrenMap = {};
  const roots = [];
  for (const n of nodes) {
    if (n.parentId) {
      if (!childrenMap[n.parentId]) childrenMap[n.parentId] = [];
      childrenMap[n.parentId].push(n);
    } else {
      roots.push(n);
    }
  }

  function renderNode(node, depth) {
    const isCurrent = node.id === data.currentNodeId;
    const statusIcon = statusIcons[node.status] || '❓';
    const typeIcon = typeIcons[node.nodeType] || '📄';
    const indent = '  '.repeat(depth);
    const connector = depth > 0 ? '├─ ' : '';
    const title = escapeHtml(node.title || node.url?.slice(0, 60) || '');
    const url = node.url ? escapeHtml(node.url) : '';
    const summary = node.summary ? escapeHtml(node.summary.slice(0, 80)) : '';
    const currentClass = isCurrent ? ' is-current' : '';
    const statusLabel = {
      'active': 'active', 'explored': 'explored',
      'promising': 'promising', 'dead_end': 'dead_end'
    }[node.status] || '';

    let html = `<div class="nav-node${currentClass}">`;
    html += `<span class="node-icon">${statusIcon}</span>`;
    html += `<span class="node-id">${escapeHtml(node.id)}</span>`;
    html += `<span class="node-icon">${typeIcon}</span>`;
    if (url) {
      html += `<span class="node-title"><a href="${url}" target="_blank" title="${url}">${title}</a></span>`;
    } else {
      html += `<span class="node-title">${title}</span>`;
    }
    if (statusLabel) {
      html += `<span class="node-status ${statusLabel}">${node.status}</span>`;
    }
    html += '</div>';

    if (summary) {
      html += `<div class="nav-node" style="padding-top:0"><span style="min-width:16px"></span><span class="node-summary">${summary}</span></div>`;
    }

    // Render children
    const children = childrenMap[node.id] || [];
    for (const child of children) {
      html += renderNode(child, depth + 1);
    }

    return html;
  }

  let html = '';
  for (const root of roots) {
    html += renderNode(root, 0);
  }
  if (!html && count > 0) {
    // Fallback: flat list if no tree structure
    for (const node of nodes) {
      html += renderNode(node, 0);
    }
  }

  navTree.innerHTML = html;
}

function requestNavTree() {
  try {
    chrome.runtime.sendMessage({ kind: 'get_memory' }).then(resp => {
      if (resp?.ok && resp.memory?.navTree) {
        updateNavMap(resp.memory.navTree);
      }
    }).catch(() => {});
  } catch (_) {}
}

// ============================================================
// EVENT HANDLING
// ============================================================

function handleEvent(msg) {
  switch (msg.kind) {
    case 'started':
      running = true;
      paused = false;
      stepCount = 0;
      totalTokens = 0;
      task = msg.task || '';
      steps.clear();
      tokenHistory = [];
      // Clear timeline
      timeline.innerHTML = '';
      if (emptyState) {
        timeline.appendChild(emptyState);
        emptyState.style.display = '';
      }
      // Reset nav map
      navTreeData = null;
      if (navMapToggle) navMapToggle.style.display = 'none';
      if (navMapContainer) navMapContainer.classList.remove('open');
      if (navTree) navTree.innerHTML = '';
      if (navMapEmpty) navMapEmpty.style.display = '';
      updateStats();
      updateControls();
      updateTaskDisplay();
      break;

    case 'step_start':
      stepCount = msg.step;
      getOrCreateStep(msg.step).timestamp = new Date(msg.ts || Date.now());
      updateStats();
      break;

    case 'agent_thought': {
      const step = getOrCreateStep(msg.step);
      step.thought = msg.thought || '';
      renderStep(step);
      break;
    }

    case 'model_call_start':
      thinkingStartTime = Date.now();
      if (thinkingTimer) clearInterval(thinkingTimer);
      thinkingTimer = setInterval(updateStats, 500);
      updateStats();
      break;

    case 'model_call_end': {
      thinkingStartTime = 0;
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
      const step = getOrCreateStep(msg.step);
      step.modelDuration = msg.duration || 0;
      step.tokensUsed = msg.tokensUsed || 0;
      step.modelId = msg.modelId || step.modelId || '';
      if (step.tokensUsed > 0) {
        tokenHistory.push({ step: msg.step, tokens: step.tokensUsed });
        updateTokenChart();
      }
      if (msg.error) {
        step.error = msg.error;
      }
      renderStep(step);
      updateStats();
      break;
    }

    case 'api_call': {
      const targetStep = stepCount > 0 ? stepCount : 0;
      if (targetStep > 0) {
        const step = getOrCreateStep(targetStep);
        step.logLines.push(`📡 ${msg.provider || 'API'} ${(msg.url || '').slice(0, 50)} → ${msg.responseStatus || '?'} (${msg.durationMs}ms)`);
        const body = document.getElementById(`step-body-${targetStep}`);
        if (body && body.classList.contains('open')) renderStep(step);
      }
      break;
    }

    case 'tokens_update':
      totalTokens = msg.totalTokensUsed || 0;
      updateStats();
      break;

    case 'log': {
      // Associate log with current step
      const targetStep = stepCount > 0 ? stepCount : 0;
      if (targetStep > 0) {
        const step = getOrCreateStep(targetStep);
        step.logLines.push(msg.text || '');
        // Keep last 20 lines per step
        if (step.logLines.length > 20) step.logLines.shift();
        // Don't re-render the full step for every log line (too noisy)
        // Only update if the step body is open
        const body = document.getElementById(`step-body-${targetStep}`);
        if (body && body.classList.contains('open')) {
          renderStep(step);
        }
      }
      break;
    }

    case 'action': {
      const step = getOrCreateStep(msg.step);
      step.action = msg.action || null;
      renderStep(step);
      break;
    }

    case 'observation': {
      const step = getOrCreateStep(msg.step);
      step.observation = msg.observation || null;
      renderStep(step);
      // Refresh nav map after each observation (navigation may have changed)
      requestNavTree();
      break;
    }

    case 'phase_changed':
      currentPhase = msg.phase || 'idle';
      updateStats();
      break;

    // ---- Model rotation event (switch between models) ----
    case 'model_rotation': {
      const rotCard = document.createElement('div');
      rotCard.className = 'step-card';
      rotCard.style.borderColor = '#6366f1';
      rotCard.style.background = 'rgba(99, 102, 241, 0.06)';
      const rotReason = msg.reason === 'primary_recovered' ? '🔄 Возврат к основной модели' : '🔀 Смена модели';
      const rotFrom = escapeHtml(shortModelName(msg.from));
      const rotTo = escapeHtml(shortModelName(msg.to));
      rotCard.innerHTML = `
        <div class="step-header" style="flex-direction:row;align-items:center;gap:6px">
          <span>🔀</span>
          <span style="flex:1;font-size:11px;color:#c4b5fd">${rotReason}: ${rotFrom} (${msg.fromRating}%) → ${rotTo} (${msg.toRating}%)</span>
        </div>`;
      timeline.appendChild(rotCard);
      timeline.scrollTop = timeline.scrollHeight;
      break;
    }

    // ---- Sleep events ----

    case 'sleep_started':
      renderSleepStartCard(msg.mode, msg.reason, msg.maxDurationSec, msg.startedAt);
      break;

    case 'sleep_ended':
      renderSleepEndCard(msg.wakeReason, msg.elapsedSec);
      break;

    case 'force_wake':
      if (isSleeping) {
        renderSleepEndCard('forced_by_user', Math.round((Date.now() - sleepStartTime) / 1000));
      }
      break;

    case 'task_updated':
      if (msg.task) task = msg.task;
      updateTaskDisplay();
      break;

    case 'finished':
      running = false;
      paused = false;
      thinkingStartTime = 0;
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
      stepCount = msg.steps || stepCount;
      updateStats();
      updateControls();

      // Show finish card
      const finCard = document.createElement('div');
      finCard.className = 'step-card';
      finCard.style.borderColor = msg.ok ? '#16a34a' : '#dc2626';
      const finEmoji = msg.ok ? '✅' : '❌';
      const finText = msg.ok ? (msg.answer || 'Готово') : (msg.reason || 'Остановлено');
      finCard.innerHTML = `
        <div class="step-header" style="flex-direction:row;align-items:center;gap:6px">
          <span>${finEmoji}</span>
          <span style="flex:1;font-size:12px;color:${msg.ok ? '#86efac' : '#fca5a5'}">${escapeHtml(finText.slice(0, 150))}</span>
        </div>`;
      timeline.appendChild(finCard);
      timeline.scrollTop = timeline.scrollHeight;
      break;

    case 'resumed_after_interrupt':
      running = true;
      paused = false;
      stepCount = msg.step || 0;
      currentPhase = msg.phase || 'idle';
      updateStats();
      updateControls();
      break;

    // ---- Navigation tree update ----
    case 'nav_tree_changed':
      if (msg.navTree) {
        updateNavMap(msg.navTree);
      }
      break;

    // ---- Infrastructure events (screenshot, page readiness) ----
    case 'infra':
    case 'screenshot_captured': {
      // Show as a compact infra line in the current step's log
      const infraStep = stepCount > 0 ? stepCount : 0;
      if (infraStep > 0) {
        const step = getOrCreateStep(infraStep);
        let line = '';
        if (msg.kind === 'infra') {
          line = msg.text || '';
        } else if (msg.kind === 'screenshot_captured') {
          line = msg.requestedByModel ? '📸 Скриншот запрошен моделью' : '📸 Скриншот получен';
        }
        if (line) {
          step.logLines.push(line);
          // Keep last 20 lines
          if (step.logLines.length > 20) step.logLines.shift();
          const body = document.getElementById(`step-body-${infraStep}`);
          if (body && body.classList.contains('open')) renderStep(step);
        }
      }
      break;
    }
  }
}

// ============================================================
// INIT
// ============================================================

// Listen for real-time events
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg._agentEvent) return;
  handleEvent(msg);
});

// Request current state + buffer on load
async function init() {
  try {
    const resp = await chrome.runtime.sendMessage({ kind: 'get_status_and_logs' });
    if (!resp) return;

    // Restore status
    const st = resp.status || {};
    running = st.running || false;
    paused = st.paused || false;
    stepCount = st.step || 0;
    totalTokens = st.totalTokensUsed || 0;
    task = st.task || '';
    currentPhase = st.phase || 'idle';

    updateStats();
    updateControls();
    updateTaskDisplay();

    // Replay buffered events
    if (Array.isArray(resp.logBuffer)) {
      for (const evt of resp.logBuffer) {
        handleEvent(evt);
      }
    }

    // Request nav tree if agent is running
    if (running) {
      requestNavTree();
    }

    // Restore sleep card if sidepanel was opened during sleep
    if (resp.currentSleep) {
      renderSleepStartCard(
        resp.currentSleep.mode,
        resp.currentSleep.reason,
        resp.currentSleep.maxDurationSec,
        resp.currentSleep.startedAt
      );
    }
  } catch (_) {
    // background not available
  }
}

// Controls
btnPause.addEventListener('click', async () => {
  if (paused) {
    await chrome.runtime.sendMessage({ kind: 'resume' });
    paused = false;
  } else {
    await chrome.runtime.sendMessage({ kind: 'pause' });
    paused = true;
  }
  updateStats();
  updateControls();
});

btnStop.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ kind: 'stop' });
});

// Filters
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    applyFilter(btn.dataset.filter);
  });
});

// Lightbox close
lightbox.addEventListener('click', () => {
  lightbox.classList.remove('active');
});

// Auto-scroll toggle: if user scrolls up, stop auto-scrolling
let autoScroll = true;
timeline.addEventListener('scroll', () => {
  const atBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 50;
  autoScroll = atBottom;
});

// Start
init();

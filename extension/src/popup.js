// popup.js — popup UI logic for WebClaw
import { formatActionHuman, formatObservationHuman, formatThought } from './format_helper.js';

const $ = (id) => document.getElementById(id);
const taskEl = $('task');
const urlEl = $('url');
const stepcapEl = $('stepcap');
const dryEl = $('dry');
const startBtn = $('start');
const stopBtn = $('stop');
const pauseBtn = $('pause');
const optionsBtn = $('options');
const logsBtn = $('logs');
const clearLogBtn = $('clear-log');
const monitorBtn = $('monitor');
const sidebarBtn = $('sidebar');
const toggleWidgetBtn = $('toggle-widget');
const applyPromptBtn = $('apply-prompt');
const applyRow = $('apply-row');
const startRow = $('start-row');
const dot = $('dot');
const meta = $('meta');
const log = $('log');

// AI Thought Card elements
const aiThoughtCard = $('ai-thought-card');
const aiThoughtText = $('ai-thought-text');
const aiActionText = $('ai-action-text');

// Phase indicator elements
const phaseIndicator = $('phase-indicator');
const phaseExecute = $('phase-execute');
const phaseDone = $('phase-done');

let running = false;
let paused = false;
let stepCount = 0;
let totalTokens = 0;
let modelName = '—';
let configSource = 'local';
let sessionData = []; // For export
let currentPhase = 'idle';

function appendLog(line, cls) {
  const div = document.createElement('div');
  if (cls) div.className = cls;
  div.textContent = line;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
  while (log.children.length > 200) log.removeChild(log.firstChild);
  
  // Store for export
  sessionData.push({
    time: new Date().toISOString(),
    text: line,
    type: cls || 'info'
  });
}

function refresh() {
  dot.className = 'dot ' + (running ? (paused ? 'paused' : 'working') : 'idle');
  startBtn.disabled = running;
  stopBtn.disabled = !running;
  pauseBtn.disabled = !running;
  pauseBtn.textContent = paused ? '▶ Продолжить' : '⏸ Пауза';
  const src = configSource === 'remote' ? 'Gist' : 'локал.';
  const phaseText = currentPhase !== 'idle' ? ` · ${currentPhase}` : '';
  const tokensText = totalTokens > 0 ? ` · 🪙 ${totalTokens.toLocaleString()} tok` : '';
  meta.textContent = `Шагов: ${stepCount} · Модель: ${modelName} · ${src} · ${running ? (paused ? 'пауза' : 'работает') : 'ожидание'}${phaseText}${tokensText}`;
  updateApplyVisibility();
}

// --- Live Prompt Editing ---
function updateApplyVisibility() {
  if (running) {
    startRow.style.display = 'none';
    // Show apply row only if task field has changed from its original value
    const origTask = taskEl.dataset.original ?? undefined;
    const dirty = origTask !== undefined && taskEl.value.trim() !== origTask;
    applyRow.style.display = dirty ? '' : 'none';
    taskEl.classList.toggle('field-dirty', origTask !== undefined && taskEl.value.trim() !== origTask);
  } else {
    startRow.style.display = '';
    applyRow.style.display = 'none';
    taskEl.classList.remove('field-dirty');
    delete taskEl.dataset.original;
  }
}

function markFieldsOriginal(task) {
  taskEl.dataset.original = task || '';
  taskEl.classList.remove('field-dirty');
}

// Track field changes for live editing
taskEl.addEventListener('input', updateApplyVisibility);

// Phase indicator management
function updatePhaseIndicator(phase) {
  currentPhase = phase;
  if (!running || phase === 'idle') {
    phaseIndicator.classList.remove('active');
    return;
  }
  phaseIndicator.classList.add('active');
  phaseExecute.classList.remove('done', 'current');
  phaseDone.classList.remove('done', 'current');
  if (phase === 'executing') {
    phaseExecute.classList.add('current');
  } else if (phase === 'done') {
    phaseExecute.classList.add('done');
    phaseDone.classList.add('done');
    // Hide indicator shortly after completion
    setTimeout(() => phaseIndicator.classList.remove('active'), 2000);
  }
  refresh();
}

async function loadSettings() {
  const v = await chrome.storage.sync.get({
    model: 'xiaomi/mimo-v2.5', step_cap: 200, remote_config_url: ''
  });
  modelName = v.model || 'xiaomi/mimo-v2.5';
  stepcapEl.value = Number.isFinite(Number(v.step_cap)) ? Number(v.step_cap) : 200;
  configSource = v.remote_config_url ? 'remote' : 'local';
  // Restore last task for convenience
  const last = await chrome.storage.local.get({ last_task: '', last_url: '' });
  taskEl.value = last.last_task || '';

  // Auto-fill URL from the current active tab if the field is empty
  if (!last.last_url) {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
        urlEl.value = tab.url;
      }
    } catch (_) {}
  } else {
    urlEl.value = last.last_url;
  }

  refresh();
}

/**
 * Request current status + buffered logs from background and update the UI.
 * This allows popup to restore full state after being closed and re-opened.
 */
async function syncWithBackground() {
  try {
    const resp = await chrome.runtime.sendMessage({ kind: 'get_status_and_logs' });
    if (!resp) return;

    // Restore status
    const st = resp.status || {};
    if (st.running) {
      running = true;
      paused = st.paused || false;
      stepCount = st.step || 0;
      totalTokens = st.totalTokensUsed || 0;
      if (st.phase && st.phase !== 'idle') {
        updatePhaseIndicator(st.phase);
      }
      refresh();
      // Mark fields as original so dirty detection works after popup reopen
      markFieldsOriginal(st.task || '');
    }

    // Replay buffered logs
    if (Array.isArray(resp.logBuffer)) {
      for (const evt of resp.logBuffer) {
        replayBufferedEvent(evt);
      }
    }
  } catch (_) {
    // background not available yet — that's fine
  }
}

/**
 * Replay a single buffered event into the popup UI (same logic as onMessage listener).
 */
function replayBufferedEvent(msg) {
  switch (msg.kind) {
    case 'started':
      running = true;
      stepCount = 0;
      refresh();
      appendLog(`▶ Задача запущена: ${msg.task || ''}`);
      break;
    case 'step_start':
      stepCount = msg.step;
      refresh();
      break;
    case 'tokens_update':
      totalTokens = msg.totalTokensUsed || (totalTokens + (msg.tokensUsed || 0));
      refresh();
      break;
    case 'log':
      appendLog(msg.text, msg.level === 'error' ? 'err' : '');
      break;
    case 'action':
      appendLog(`#${msg.step} ${formatActionHuman(msg.action)}`, 'act');
      if (aiActionText) {
        aiActionText.textContent = formatActionHuman(msg.action);
        aiActionText.classList.remove('hidden');
      }
      break;
    case 'observation':
      appendLog(`#${msg.step} → ${formatObservationHuman(msg.observation)}`);
      break;
    case 'agent_thought':
      appendLog(`💭 #${msg.step}: ${formatThought(msg.thought)}`, 'act');
      if (aiThoughtCard) {
        aiThoughtCard.classList.remove('hidden');
        aiThoughtText.textContent = formatThought(msg.thought);
      }
      break;
    case 'model_call_start':
      appendLog(`⏳ #${msg.step}: модель думает...`);
      break;
    case 'model_call_end':
      if (msg.error) {
        appendLog(`❌ #${msg.step}: ошибка модели: ${msg.error}`, 'err');
      } else {
        appendLog(`✓ #${msg.step}: ответ за ${(msg.duration / 1000).toFixed(1)}с${msg.tokensUsed ? ' · 🪙' + msg.tokensUsed : ''}`);
      }
      break;
    case 'api_call':
      appendLog(`📡 ${msg.provider || 'API'} ${msg.method || 'POST'} ${(msg.url || '').slice(0, 50)} → ${msg.responseStatus || '?'}${msg.error ? ' ERR' : ''} (${msg.durationMs}ms)`, msg.error ? 'err' : '');
      break;
    case 'phase_changed':
      updatePhaseIndicator(msg.phase);
      appendLog(`Фаза: ${msg.phase}`);
      break;
    case 'resumed_after_interrupt':
      running = true;
      paused = false;
      stepCount = msg.step || 0;
      refresh();
      appendLog(`⚡ Возобновлено на шаге ${msg.step}`, 'act');
      break;
    case 'finished':
      running = false;
      paused = false;
      stepCount = msg.steps || stepCount;
      updatePhaseIndicator('done');
      refresh();
      appendLog(msg.ok ? ('✔ ' + (msg.answer || 'Готово')) : ('✖ ' + (msg.reason || 'Остановлено')),
                 msg.ok ? 'ok' : 'err');
      break;
    case 'task_updated':
      appendLog(`✏️ Промпт обновлён на шаге ${msg.step}`);
      if (msg.task) taskEl.dataset.original = msg.task;
      updateApplyVisibility();
      break;
  }
}

// Preset Tasks functionality
function initPresets() {
  const presetBtns = document.querySelectorAll('.preset-btn');
  presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const task = btn.dataset.task;
      taskEl.value = task;
      
      // Visual feedback
      btn.style.background = '#16a34a';
      btn.style.borderColor = '#16a34a';
      setTimeout(() => {
        btn.style.background = '';
        btn.style.borderColor = '';
      }, 300);
      
      appendLog(`⚡ Шаблон загружен: ${task.slice(0, 40)}...`);
    });
  });
}

startBtn.addEventListener('click', async () => {
  const task = taskEl.value.trim();
  if (!task) { appendLog('Введите задачу', 'err'); return; }
  const stepCap = Math.max(1, Math.min(2000, parseInt(stepcapEl.value, 10) || 200));
  const initialUrl = urlEl.value.trim() || null;
  const dryRun = !!dryEl.checked;

  await chrome.storage.local.set({
    last_task: task, last_url: initialUrl || ''
  });
  await chrome.storage.sync.set({ step_cap: stepCap });

  stepCount = 0;
  totalTokens = 0;
  sessionData = [];
  running = true;
  paused = false;
  refresh();
  appendLog('▶ Запущено' + (dryRun ? ' [ТЕСТ]' : '') + ': ' + task);

  // Fire-and-forget: background responds immediately with {ok: true, started: true}
  // and continues the agent loop in the background. All subsequent events come via broadcast.
  const r = await chrome.runtime.sendMessage({
    kind: 'start',
    task,
    context: '',
    initialUrl,
    options: { stepCap, dryRun }
  });
  if (!r || !r.ok) {
    running = false;
    refresh();
    const err = r?.error || 'unknown';
    appendLog('Ошибка запуска: ' + err, 'err');
    if (err === 'missing_settings') {
      appendLog('Откройте Настройки и заполните токен / email / модель', 'err');
    }
  } else {
    markFieldsOriginal(task);
  }
});

// --- Apply prompt changes while agent is running ---
applyPromptBtn.addEventListener('click', async () => {
  const newTask = taskEl.value.trim();
  if (!newTask) { appendLog('Задача не может быть пустой', 'err'); return; }

  applyPromptBtn.textContent = '✏️ Отправка...';
  applyPromptBtn.disabled = true;

  try {
    const r = await chrome.runtime.sendMessage({
      kind: 'update_prompt',
      task: newTask,
      context: ''
    });
    if (r?.ok && r.changed) {
      appendLog('✏️ Промпт обновлён — применится на следующем шаге', 'ok');
      applyPromptBtn.textContent = '✅ Применено';
      applyPromptBtn.classList.add('sent');
      markFieldsOriginal(newTask);
      setTimeout(() => {
        applyPromptBtn.textContent = '✏️ Применить изменения';
        applyPromptBtn.classList.remove('sent');
        applyPromptBtn.disabled = false;
        updateApplyVisibility();
      }, 1500);
    } else if (r?.ok && !r.changed) {
      appendLog('✏️ Нет изменений');
      applyPromptBtn.textContent = '✏️ Применить изменения';
      applyPromptBtn.disabled = false;
      updateApplyVisibility();
    } else {
      appendLog('Ошибка: ' + (r?.error || 'unknown'), 'err');
      applyPromptBtn.textContent = '✏️ Применить изменения';
      applyPromptBtn.disabled = false;
    }
  } catch (e) {
    appendLog('Ошибка отправки: ' + e.message, 'err');
    applyPromptBtn.textContent = '✏️ Применить изменения';
    applyPromptBtn.disabled = false;
  }
});

stopBtn.addEventListener('click', async () => {
  appendLog('⏹ Остановка...');
  // Optimistic UI update — don't wait for broadcast
  running = false;
  paused = false;
  refresh();
  try {
    await chrome.runtime.sendMessage({ kind: 'stop' });
  } catch (e) {
    appendLog('Ошибка остановки: ' + (e.message || 'SW недоступен'), 'err');
    // Even if SW is not responding, clear persisted state on next wake
  }
});

pauseBtn.addEventListener('click', async () => {
  if (paused) {
    await chrome.runtime.sendMessage({ kind: 'resume' });
    paused = false;
    appendLog('▶ Продолжено');
  } else {
    await chrome.runtime.sendMessage({ kind: 'pause' });
    paused = true;
    appendLog('⏸ Приостановлено');
  }
  refresh();
});

optionsBtn.addEventListener('click', () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (_) {
    // Fallback: open options.html directly
    window.open(chrome.runtime.getURL('src/options.html'), '_blank');
  }
});
logsBtn.addEventListener('click', () => {
  window.open(chrome.runtime.getURL('src/logs.html'), '_blank');
});

clearLogBtn.addEventListener('click', async () => {
  log.textContent = '';
  sessionData = [];
  if (aiThoughtCard) aiThoughtCard.classList.add('hidden');
  if (aiThoughtText) aiThoughtText.textContent = '';
  if (aiActionText) {
    aiActionText.textContent = '';
    aiActionText.classList.add('hidden');
  }
  try {
    await chrome.runtime.sendMessage({ kind: 'clear_logs' });
  } catch (_) {}
  appendLog('🧹 Логи очищены');
});

stepcapEl.addEventListener('change', async () => {
  const stepCap = Math.max(1, Math.min(2000, parseInt(stepcapEl.value, 10) || 200));
  stepcapEl.value = stepCap;
  await chrome.storage.sync.set({ step_cap: stepCap });
});

monitorBtn.addEventListener('click', async () => {
  try {
    // Open Side Panel via chrome.sidePanel API (Chrome 114+)
    if (chrome.sidePanel) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const windowId = tab?.windowId || (await chrome.windows.getCurrent()).id;
      if (windowId) {
        await chrome.sidePanel.open({ windowId });
      } else {
        throw new Error('no windowId');
      }
    } else {
      // Fallback: open sidepanel.html in a new tab
      window.open(chrome.runtime.getURL('src/sidepanel.html'), '_blank');
    }
  } catch (_) {
    window.open(chrome.runtime.getURL('src/sidepanel.html'), '_blank');
  }
});

sidebarBtn.addEventListener('click', async () => {
  try {
    if (chrome.sidePanel && chrome.sidePanel.open) {
      // Get the current window ID — popup knows which window it's in
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const windowId = tab?.windowId || (await chrome.windows.getCurrent()).id;
      if (windowId) {
        await chrome.sidePanel.open({ windowId });
        appendLog('🪟 Сайдбар открыт', 'ok');
      } else {
        throw new Error('no windowId');
      }
    } else {
      window.open(chrome.runtime.getURL('src/sidepanel.html'), '_blank');
      appendLog('🪟 Сайдбар открыт в новой вкладке');
    }
  } catch (e) {
    window.open(chrome.runtime.getURL('src/sidepanel.html'), '_blank');
    appendLog('🪟 Сайдбар открыт в новой вкладке (fallback)');
  }
});

let widgetVisible = false; // track widget state for toggle

function updateWidgetButton(visible) {
  widgetVisible = !!visible;
  toggleWidgetBtn.textContent = widgetVisible ? '🔲 Виджет ✓' : '🔲 Виджет';
}

async function syncWidgetButtonState() {
  try {
    const r = await chrome.runtime.sendMessage({ kind: 'get_overlay_widget_visibility' });
    if (r?.ok) {
      updateWidgetButton(!!r.visible);
    } else {
      updateWidgetButton(false);
    }
  } catch (_) {
    updateWidgetButton(false);
  }
}

toggleWidgetBtn.addEventListener('click', async () => {
  try {
    // Popup cannot talk to content scripts directly —
    // always relay through background service worker.
    const r = await chrome.runtime.sendMessage({ kind: 'toggle_overlay_widget' });
    if (r?.ok) {
      updateWidgetButton(!!r.visible);
      appendLog(widgetVisible ? '🔲 Виджет показан' : '🔲 Виджет скрыт');
    } else {
      appendLog('Виджет недоступен: ' + (r?.error || 'нет активной вкладки'), 'err');
      await syncWidgetButtonState();
    }
  } catch (e) {
    appendLog('Ошибка: виджет недоступен на этой странице', 'err');
    await syncWidgetButtonState();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg._agentEvent) return;
  switch (msg.kind) {
    case 'step_start':
      stepCount = msg.step;
      refresh();
      break;
    case 'tokens_update':
      totalTokens = msg.totalTokensUsed || (totalTokens + (msg.tokensUsed || 0));
      refresh();
      break;
    case 'log':
      appendLog(msg.text, msg.level === 'error' ? 'err' : '');
      break;
    case 'action':
      appendLog(`#${msg.step} ${formatActionHuman(msg.action)}`, 'act');
      if (aiActionText) {
        aiActionText.textContent = formatActionHuman(msg.action);
        aiActionText.classList.remove('hidden');
      }
      break;
    case 'observation':
      appendLog(`#${msg.step} → ${formatObservationHuman(msg.observation)}`);
      break;
    case 'agent_thought':
      appendLog(`💭 #${msg.step}: ${formatThought(msg.thought)}`, 'act');
      if (aiThoughtCard) {
        aiThoughtCard.classList.remove('hidden');
        aiThoughtText.textContent = formatThought(msg.thought);
      }
      break;
    case 'model_call_start':
      appendLog(`⏳ #${msg.step}: модель думает...`);
      break;
    case 'model_call_end':
      if (msg.error) {
        appendLog(`❌ #${msg.step}: ошибка модели: ${msg.error}`, 'err');
      } else {
        appendLog(`✓ #${msg.step}: ответ за ${(msg.duration / 1000).toFixed(1)}с${msg.tokensUsed ? ' · 🪙' + msg.tokensUsed : ''}`);
      }
      break;
    case 'api_call':
      appendLog(`📡 ${msg.provider || 'API'} ${msg.method || 'POST'} ${(msg.url || '').slice(0, 50)} → ${msg.responseStatus || '?'}${msg.error ? ' ERR' : ''} (${msg.durationMs}ms)`, msg.error ? 'err' : '');
      break;
    case 'phase_changed':
      updatePhaseIndicator(msg.phase);
      appendLog(`Фаза: ${msg.phase}`);
      break;
    case 'resumed_after_interrupt':
      running = true;
      paused = false;
      stepCount = msg.step || 0;
      refresh();
      appendLog(`⚡ Возобновлено после перезагрузки SW на шаге ${msg.step} (фаза: ${msg.phase}, режим: ${msg.loopType})`, 'act');
      break;
    case 'finished':
      running = false;
      paused = false;
      stepCount = msg.steps || stepCount;
      updatePhaseIndicator('done');
      refresh();
      appendLog(msg.ok ? ('✔ ' + (msg.answer || 'Готово')) : ('✖ ' + (msg.reason || 'Остановлено')),
                 msg.ok ? 'ok' : 'err');
      break;
    case 'task_updated':
      appendLog(`✏️ Промпт обновлён на шаге ${msg.step}`);
      // Update original values so dirty detection stays accurate
      if (msg.task) taskEl.dataset.original = msg.task;
      updateApplyVisibility();
      break;
  }
});

// Initialize
initPresets();
loadSettings().then(async () => {
  await syncWithBackground();
  await syncWidgetButtonState();
});

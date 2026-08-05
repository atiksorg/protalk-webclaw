// logs.js — full-screen log viewer for the agent

const $ = (id) => document.getElementById(id);
const main = $('main');
const filter = $('filter');
const pauseBtn = $('pause');
const clearBtn = $('clear');
const status = $('status');

let paused = false;
let lines = [];

function addLine(text, cls) {
  const t = new Date();
  const hh = String(t.getHours()).padStart(2, '0');
  const mm = String(t.getMinutes()).padStart(2, '0');
  const ss = String(t.getSeconds()).padStart(2, '0');
  const ts = `${hh}:${mm}:${ss}`;
  const f = (filter.value || '').toLowerCase();
  if (f && !text.toLowerCase().includes(f)) return;
  const div = document.createElement('div');
  div.className = 'row' + (cls ? ' ' + cls : '');
  div.innerHTML = `<span class="ts">${ts}</span>${escapeHtml(text)}`;
  main.appendChild(div);
  lines.push({ text, cls });
  if (lines.length > 2000) {
    main.removeChild(main.firstChild);
    lines.shift();
  }
  if (!paused) main.scrollTop = main.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

filter.addEventListener('input', () => {
  // re-render filtered
  const f = filter.value.toLowerCase();
  main.innerHTML = '';
  for (const l of lines) {
    if (f && !l.text.toLowerCase().includes(f)) continue;
    const div = document.createElement('div');
    div.className = 'row' + (l.cls ? ' ' + l.cls : '');
    div.innerHTML = `<span class="ts">··:··:··</span>${escapeHtml(l.text)}`;
    main.appendChild(div);
  }
});

pauseBtn.addEventListener('click', () => {
  paused = !paused;
  pauseBtn.textContent = paused ? 'Продолжить скролл' : 'Пауза авто-скролла';
});

clearBtn.addEventListener('click', () => {
  main.innerHTML = '';
  lines = [];
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg._agentEvent) return;
  switch (msg.kind) {
    case 'log':
      addLine(msg.text, msg.level === 'error' ? 'err' : '');
      break;
    case 'action':
      addLine(`#${msg.step} action: ${JSON.stringify(msg.action)}`, 'act');
      break;
    case 'observation':
      addLine(`#${msg.step} → ${JSON.stringify(msg.observation).slice(0, 300)}`);
      break;
    case 'agent_thought':
      addLine(`💭 #${msg.step} думает: ${msg.thought}`, 'act');
      break;
    case 'model_call_start':
      addLine(`⏳ #${msg.step} модель думает...`);
      break;
    case 'model_call_end':
      if (msg.error) {
        addLine(`❌ #${msg.step} ошибка модели: ${msg.error}`, 'err');
      } else {
        addLine(`✓ #${msg.step} ответ за ${(msg.duration / 1000).toFixed(1)}с${msg.tokensUsed ? ' · 🪙' + msg.tokensUsed : ''}`);
      }
      break;
    case 'api_call':
      addLine(`📡 API ${msg.method || 'POST'} ${(msg.url || '').slice(0, 60)} → HTTP ${msg.responseStatus || '?'}${msg.error ? ' ERR: ' + msg.error : ''} (${msg.durationMs}ms)`, msg.error ? 'err' : '');
      break;
    case 'step_start':
      status.textContent = `шаг ${msg.step}`;
      break;
    case 'phase_changed':
      addLine(`⚙ фаза: ${msg.phase}`, 'act');
      break;
    case 'finished':
      status.textContent = msg.ok ? '✓ готово' : '✖ стоп';
      addLine(msg.ok ? ('✔ ' + (msg.answer || 'готово')) : ('✖ ' + (msg.reason || 'стоп')), msg.ok ? 'ok' : 'err');
      break;
    case 'started':
      status.textContent = 'запущен';
      addLine('▶ старт: ' + (msg.task || ''));
      break;
  }
});

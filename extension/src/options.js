// options.js — settings page logic

import { getSettings, setSettings, clearSettings } from './settings.js';
import { probeRemoteConfig } from './remote_config.js';
import { testProvider } from './providers.js';

const $ = (id) => document.getElementById(id);
const providerEl = $('provider');
const apiBaseUrlEl = $('api_base_url');
const apiKeyEl = $('api_key');
const tokenEl = $('auth_token');
const token2El = $('auth_token2');
const emailEl = $('user_email');
const modelEl = $('model');
const modelCustomEl = $('model_custom');
const modelProtalkEl = $('model_protalk');
const modelProtalkCustomEl = $('model_protalk_custom');
const tempEl = $('temperature');
const reasonEl = $('reasoning');
const stepEl = $('step_cap');
const ctxEl = $('user_context');
const remoteEl = $('remote_config_url');
const fetchRemoteBtn = $('fetch_remote');
const showGistBtn = $('show_gist_format');
const gistTpl = $('gist_template');
const exportBtn = $('export_config');
const importBtn = $('import_config');
const importFileEl = $('import_file');
const saveBtn = $('save');
const testBtn = $('test');
const statusEl = $('status');
// Provider section containers
const protalkFieldsEl = $('protalk_fields');
const nonProtalkFieldsEl = $('non_protalk_fields');
// v3.0 elements
const cdpInputEl = $('cdp_input_mode');
const spaNetIdleEl = $('spa_network_idle_ms');
const spaDomStableEl = $('spa_dom_stable_ms');
const viewportWidthEl = $('agent_viewport_width');
const viewportHeightEl = $('agent_viewport_height');
// v8.0 token budget
const tokenLimitEl = $('token_limit');

const KNOWN = new Set([
  'xiaomi/mimo-v2.5',
  'moonshotai/kimi-k2.7-code',
  'google/gemini-3.5-flash',
  'openai/gpt-5.6-luna',
  'google/gemini-3.1-flash-lite-preview',
  'qwen/qwen3.7-flash',
  'google/gemini-2.5-pro',
  'meta-llama/llama-3.2-90b-vision-instruct'
]);

function effectiveModel() {
  const isProTalk = providerEl.value === 'protalk';
  const sel = isProTalk ? modelProtalkEl : modelEl;
  const custom = isProTalk ? modelProtalkCustomEl : modelCustomEl;
  if (sel.value === '__custom__') return (custom.value || '').trim();
  return sel.value;
}

function applyModelToUI(model, isProTalk) {
  const sel = isProTalk ? modelProtalkEl : modelEl;
  const custom = isProTalk ? modelProtalkCustomEl : modelCustomEl;
  if (KNOWN.has(model)) {
    sel.value = model;
    custom.style.display = 'none';
  } else if (model) {
    sel.value = '__custom__';
    custom.style.display = '';
    custom.value = model;
  }
}

modelEl.addEventListener('change', () => {
  modelCustomEl.style.display = modelEl.value === '__custom__' ? '' : 'none';
});

modelProtalkEl.addEventListener('change', () => {
  modelProtalkCustomEl.style.display = modelProtalkEl.value === '__custom__' ? '' : 'none';
});

function toggleProviderFields() {
  const isProTalk = providerEl.value === 'protalk';
  protalkFieldsEl.classList.toggle('hidden', !isProTalk);
  nonProtalkFieldsEl.classList.toggle('hidden', isProTalk);
}

providerEl.addEventListener('change', toggleProviderFields);

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status' + (cls ? ' ' + cls : '');
}

async function load() {
  const s = await getSettings();
  tokenEl.value = s.auth_token || '';
  emailEl.value = s.user_email || '';
  providerEl.value = s.provider || 'protalk';
  apiBaseUrlEl.value = s.api_base_url || '';
  apiKeyEl.value = s.api_key || '';
  applyModelToUI(s.model || 'xiaomi/mimo-v2.5');
  tempEl.value = s.temperature ?? 0.2;
  reasonEl.value = s.reasoning || 'low';
  stepEl.value = s.step_cap || 200;
  ctxEl.value = s.user_context || '';
  remoteEl.value = s.remote_config_url || '';
  // v3.0
  cdpInputEl.checked = s.cdp_input_mode !== false;
  spaNetIdleEl.value = s.spa_network_idle_ms || 500;
  spaDomStableEl.value = s.spa_dom_stable_ms || 300;
  viewportWidthEl.value = s.agent_viewport_width || 1280;
  viewportHeightEl.value = s.agent_viewport_height || 800;
  // Toggle provider-specific fields
  toggleProviderFields();
  // v8.0 token budget
  tokenLimitEl.value = s.token_limit || 1000000;
  // Load ProTalk model
  applyModelToUI(s.model || 'xiaomi/mimo-v2.5', true);
}

saveBtn.addEventListener('click', async () => {
  const prov = providerEl.value;
  const isProTalk = prov === 'protalk';
  const isOllama = prov === 'ollama';

  // For ProTalk: need auth_token + user_email + model
  // For others: need model + auth (token2 or api_key)
  if (isProTalk) {
    if (!tokenEl.value.trim()) {
      setStatus('Заполните Auth Token', 'err'); return;
    }
    const model = effectiveModel();
    if (!model) { setStatus('Выберите модель', 'err'); return; }
  } else {
    const model = effectiveModel();
    if (!model) { setStatus('Выберите модель', 'err'); return; }
    if (!isOllama && !token2El.value.trim() && !apiKeyEl.value.trim()) {
      setStatus('Заполните Auth Token или API Key', 'err'); return;
    }
  }

  // Determine auth_token: ProTalk uses tokenEl, others use token2El
  const authToken = isProTalk ? tokenEl.value.trim() : token2El.value.trim();

  await setSettings({
    auth_token: authToken,
    user_email: emailEl.value.trim(),
    model: effectiveModel(),
    provider: prov,
    api_base_url: isProTalk ? '' : apiBaseUrlEl.value.trim(),
    api_key: isProTalk ? '' : apiKeyEl.value.trim(),
    temperature: isProTalk ? 0.3 : (parseFloat(tempEl.value) || 0.2),
    reasoning: isProTalk ? 'low' : reasonEl.value,
    step_cap: isProTalk ? 200 : Math.max(1, Math.min(2000, parseInt(stepEl.value, 10) || 200)),
    user_context: ctxEl.value,
    remote_config_url: remoteEl.value.trim(),
    // v3.0
    cdp_input_mode: cdpInputEl.checked,
    spa_network_idle_ms: parseInt(spaNetIdleEl.value, 10) || 500,
    spa_dom_stable_ms: parseInt(spaDomStableEl.value, 10) || 300,
    agent_viewport_width: parseInt(viewportWidthEl.value, 10) || 1280,
    agent_viewport_height: parseInt(viewportHeightEl.value, 10) || 800
  });
  // v8.0 token budget — save separately to ensure it's always set
  const tokenLimit = Math.max(1000, Math.min(50000000, parseInt(tokenLimitEl.value, 10) || 1000000));
  await setSettings({ token_limit: tokenLimit });
  setStatus('Сохранено ✓', 'ok');
});

showGistBtn.addEventListener('click', () => {
  gistTpl.style.display = gistTpl.style.display === 'none' ? 'block' : 'none';
});

fetchRemoteBtn.addEventListener('click', async () => {
  const url = remoteEl.value.trim();
  if (!url) { setStatus('Введите URL', 'err'); return; }
  setStatus('Загружаю конфиг...');
  const r = await probeRemoteConfig(url);
  if (!r.ok) { setStatus('Не удалось загрузить: ' + r.error, 'err'); return; }
  const c = r.config;
  // Merge: remote fills empty fields only (we don't want to clobber what user has).
  // SECURITY: auth_token and api_key are NEVER imported from remote config
  if (!emailEl.value.trim() && c.user_email) emailEl.value = c.user_email;
  if (c.provider) providerEl.value = c.provider;
  if (!apiBaseUrlEl.value.trim() && c.api_base_url) apiBaseUrlEl.value = c.api_base_url;
  if (c.model) {
    applyModelToUI(c.model);
    applyModelToUI(c.model, true);
  }
  if (c.temperature != null) tempEl.value = c.temperature;
  if (c.reasoning) reasonEl.value = c.reasoning;
  if (c.step_cap != null) stepEl.value = c.step_cap;
  if (!ctxEl.value.trim() && c.user_context) ctxEl.value = c.user_context;
  // v3.0
  if (c.cdp_input_mode !== undefined) cdpInputEl.checked = !!c.cdp_input_mode;
  if (c.spa_network_idle_ms != null) spaNetIdleEl.value = c.spa_network_idle_ms;
  if (c.spa_dom_stable_ms != null) spaDomStableEl.value = c.spa_dom_stable_ms;
  if (c.agent_viewport_width != null) viewportWidthEl.value = c.agent_viewport_width;
  if (c.agent_viewport_height != null) viewportHeightEl.value = c.agent_viewport_height;
  // v8.0 token budget
  if (c.token_limit != null) tokenLimitEl.value = c.token_limit;
  setStatus('Конфиг загружен. Не забудь нажать «Сохранить».', 'ok');
});

// ── Export config to JSON file ──
exportBtn.addEventListener('click', async () => {
  const prov = providerEl.value;
  const isProTalk = prov === 'protalk';

  const config = {
    _exported_at: new Date().toISOString(),
    _note: 'Auth Token экспортируется для удобства переноса. api_key НЕ экспортируется.',
    provider: prov,
    auth_token: isProTalk ? tokenEl.value.trim() : token2El.value.trim(),
    user_email: emailEl.value.trim(),
    model: effectiveModel(),
    api_base_url: isProTalk ? '' : apiBaseUrlEl.value.trim(),
    temperature: isProTalk ? 0.3 : (parseFloat(tempEl.value) || 0.2),
    reasoning: isProTalk ? 'low' : reasonEl.value,
    step_cap: isProTalk ? 200 : Math.max(1, Math.min(2000, parseInt(stepEl.value, 10) || 200)),
    user_context: ctxEl.value,
    remote_config_url: remoteEl.value.trim(),
    // v3.0
    cdp_input_mode: cdpInputEl.checked,
    spa_network_idle_ms: parseInt(spaNetIdleEl.value, 10) || 500,
    spa_dom_stable_ms: parseInt(spaDomStableEl.value, 10) || 300,
    agent_viewport_width: parseInt(viewportWidthEl.value, 10) || 1280,
    agent_viewport_height: parseInt(viewportHeightEl.value, 10) || 800
  };

  // v8.0 token budget
  config.token_limit = Math.max(1000, Math.min(50000000, parseInt(tokenLimitEl.value, 10) || 1000000));

  const json = JSON.stringify(config, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `webclaw-config-${prov}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  setStatus('Конфиг экспортирован ✓', 'ok');
});

// ── Import config from JSON file ──
importBtn.addEventListener('click', () => {
  importFileEl.click();
});

importFileEl.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const config = JSON.parse(text);
    // Apply to form
    if (config.provider) providerEl.value = config.provider;
    if (config.user_email != null) emailEl.value = config.user_email;
    if (config.model) {
      applyModelToUI(config.model);
      applyModelToUI(config.model, true);
    }
    if (config.auth_token != null) {
      const isProTalk = config.provider === 'protalk';
      if (isProTalk) tokenEl.value = config.auth_token;
      else token2El.value = config.auth_token;
    }
    if (config.api_base_url != null) apiBaseUrlEl.value = config.api_base_url;
    if (config.temperature != null) tempEl.value = config.temperature;
    if (config.reasoning) reasonEl.value = config.reasoning;
    if (config.step_cap != null) stepEl.value = config.step_cap;
    if (config.user_context != null) ctxEl.value = config.user_context;
    if (config.remote_config_url != null) remoteEl.value = config.remote_config_url;
    // v3.0
    if (config.cdp_input_mode !== undefined) cdpInputEl.checked = !!config.cdp_input_mode;
    if (config.spa_network_idle_ms != null) spaNetIdleEl.value = config.spa_network_idle_ms;
    if (config.spa_dom_stable_ms != null) spaDomStableEl.value = config.spa_dom_stable_ms;
    if (config.agent_viewport_width != null) viewportWidthEl.value = config.agent_viewport_width;
    if (config.agent_viewport_height != null) viewportHeightEl.value = config.agent_viewport_height;
    // v8.0 token budget
    if (config.token_limit != null) tokenLimitEl.value = config.token_limit;
    // Update provider-specific field visibility
    toggleProviderFields();
    setStatus('Конфиг загружен из файла. Не забудь нажать «Сохранить».', 'ok');
  } catch (err) {
    setStatus('Ошибка чтения файла: ' + err.message, 'err');
  }
  // Reset file input so the same file can be re-imported
  importFileEl.value = '';
});

testBtn.addEventListener('click', async () => {
  setStatus('Проверяю...');
  const prov = providerEl.value;
  const isProTalk = prov === 'protalk';
  // Build a temporary settings object from form values
  const testSettings = {
    provider: prov,
    auth_token: isProTalk ? tokenEl.value.trim() : token2El.value.trim(),
    api_key: isProTalk ? '' : apiKeyEl.value.trim(),
    user_email: emailEl.value.trim(),
    api_base_url: isProTalk ? '' : apiBaseUrlEl.value.trim(),
    model: effectiveModel(),
    temperature: isProTalk ? 0.3 : (parseFloat(tempEl.value) || 0.2),
    reasoning: isProTalk ? 'low' : reasonEl.value
  };
  if (!testSettings.model) {
    setStatus('Сначала выберите модель', 'err'); return;
  }
  const r = await testProvider(testSettings);
  if (r.ok) {
    setStatus(`OK · ${r.provider}: ${r.reply}`, 'ok');
  } else {
    setStatus('Ошибка: ' + r.error, 'err');
  }
});

load();

// settings.js — multi-source settings store.
//
// Resolution order (later overrides earlier):
//   1. Defaults
//   2. chrome.storage.sync        — primary, non-secret settings
//   3. chrome.storage.local       — SECRETS ONLY (auth_token, api_key) — never synced to Google Account
//   4. chrome.storage.local.cache — mirror of the last good remote fetch
//   5. remote config URL          — a JSON file at a user-provided URL
//
// Security: auth_token and api_key are stored ONLY in chrome.storage.local
// (device-local, never synced, never backed up to Google Account).
// Remote config (Gist) is NOT allowed to import secrets.

import { fetchRemoteConfig } from './remote_config.js';

const KEY_TOKEN = 'auth_token';
const KEY_EMAIL = 'user_email';
const KEY_MODEL = 'model';
const KEY_PROVIDER = 'provider';
const KEY_API_BASE = 'api_base_url';
const KEY_API_KEY = 'api_key';
const KEY_TEMP  = 'temperature';
const KEY_REAS  = 'reasoning';
const KEY_STEPCAP = 'step_cap';
const KEY_USERCTX = 'user_context';
const KEY_REMOTECFG = 'remote_config_url';
// New v3.0 keys
const KEY_CDP_INPUT = 'cdp_input_mode';
const KEY_SPA_NETIDLE = 'spa_network_idle_ms';
const KEY_SPA_DOMSTABLE = 'spa_dom_stable_ms';
const KEY_VIEWPORT_W = 'agent_viewport_width';
const KEY_VIEWPORT_H = 'agent_viewport_height';
// Long-running process monitoring keys (v3.1)
const KEY_WAIT_TIMEOUT = 'wait_timeout_default';
const KEY_WAIT_ERROR_DETECT = 'wait_error_detection';
const KEY_WAIT_STALL_THRESHOLD = 'wait_progress_stall_threshold';
// Batch mode keys (v4.0)
const KEY_ACTION_DELAY = 'action_delay_ms';
const KEY_MAX_ACTIONS = 'max_actions_per_session';
const KEY_AUTONOMY = 'autonomy_mode';            // 'full' = no confirmation, 'safe' = require human approval
// v6.0 Micro-loop & self-healing
const KEY_BATCH_STEPS = 'batch_steps_per_item';      // Max model calls per batch item
const KEY_AD_BLOCKLIST = 'ad_domain_blocklist';       // Ad/tracker domains to skip
// v5.1 ProTalk file server
const KEY_UPLOAD_TOKEN = 'protalk_upload_token';
// v8.0 Token budget
const KEY_TOKEN_LIMIT = 'token_limit';
// v9.0 Sleep mode
const KEY_SLEEP_POLL_INTERVAL = 'sleep_poll_interval_ms';
const KEY_SLEEP_MAX_DURATION = 'sleep_max_duration_ms';
// v9.1 Deep sleep (hibernation)
const KEY_DEEP_SLEEP_POLL_INTERVAL = 'deep_sleep_poll_interval_ms';
const KEY_DEEP_SLEEP_MAX_DURATION = 'deep_sleep_max_duration_ms';
// v9.2 Anti-Blink (fast-track for custom dropdowns)
const KEY_FAST_TRACK_DELAY = 'fast_track_delay_ms';
// v9.3 Human-like mouse movement (Bezier interpolation)
const KEY_MOUSE_MOVE_JITTER = 'mouse_move_jitter';
const KEY_MOUSE_MOVE_BASE_DELAY = 'mouse_move_base_delay';
// v11.0 Model Rotation (fallback models with stability ratings)
const KEY_FALLBACK_MODELS = 'fallback_models';
const KEY_SWITCH_THRESHOLD = 'switch_threshold';
const KEY_RECOVERY_THRESHOLD = 'recovery_threshold';

// v10.0 Persistent Memory (Events API)
const KEY_PMEM_ENABLED = 'persistent_memory_enabled';
const KEY_PMEM_SRC_BASE = 'persistent_memory_src_base';
const KEY_PMEM_SRC_SUFFIX = 'persistent_memory_src_suffix';
const KEY_PMEM_SRC = 'persistent_memory_src';

const DEFAULTS = {
  auth_token: '',
  user_email: '',
  model: 'xiaomi/mimo-v2.5',
  provider: 'protalk',         // protalk | openai | anthropic | ollama
  api_base_url: '',            // custom endpoint (e.g. OpenRouter, local Ollama)
  api_key: '',                 // direct API key (for openai/anthropic providers)
  temperature: 0.2,
  reasoning: 'low',
  step_cap: 200,
  user_context: '',
  // v3.0 defaults
  cdp_input_mode: false,         // Use CDP for trusted input events (off by default)
  spa_network_idle_ms: 500,      // Network idle threshold (ms)
  spa_dom_stable_ms: 300,        // DOM stability threshold (ms)
  agent_viewport_width: 1280,    // Predictable viewport width for AI
  agent_viewport_height: 800,    // Predictable viewport height for AI
  // v3.1 long-running process monitoring
  wait_timeout_default: 120000,   // Default timeout for wait_for_completion (ms)
  wait_error_detection: true,     // Auto-detect error text during waits
  wait_progress_stall_threshold: 10, // Polls without progress change before stall
  // v4.0 batch mode
  action_delay_ms: 2000,          // Delay between batch actions (ms)
  max_actions_per_session: 50,    // Max actions per batch session
  autonomy_mode: 'full',          // 'full' = autonomous (no confirm), 'safe' = require human approval
  // v6.0 Micro-loop & self-healing
  batch_steps_per_item: 5,        // Max model calls per batch item (micro-loop)
  ad_domain_blocklist: 'rtb.mts.ru,sm.rtb.mts.ru,doubleclick.net,googlesyndication.com,googleadservices.com,facebook.com/tr,analytics.google.com',  // Ad/tracker domains to skip in frame discovery
  // v5.1 ProTalk file server
  protalk_upload_token: '',       // Custom upload token for ProTalk file server (optional)
  // v8.0 Token budget
  token_limit: 1000000,           // Max total tokens per session — hard stop when exceeded
  // v9.0 Sleep mode
  sleep_poll_interval_ms: 3000,   // Interval between screenshot checks during sleep (ms)
  sleep_max_duration_ms: 300000,  // Maximum sleep duration before forced wake (5 min)
  // v9.1 Deep sleep (hibernation)
  deep_sleep_poll_interval_ms: 5000,  // Interval between screenshots during watchful sleep (ms)
  deep_sleep_max_duration_ms: 86400000, // Maximum deep sleep duration (24 hours)
  // v9.2 Anti-Blink (fast-track for custom dropdowns)
  fast_track_delay_ms: 100,  // Delay after paint for CSS transitions to settle (ms)
  // v9.3 Human-like mouse movement (Bezier interpolation)
  mouse_move_jitter: 1.5,      // Random deviation per step in pixels (hand tremor simulation)
  mouse_move_base_delay: 10,   // Base delay between path points in ms
  // v11.0 Model Rotation (fallback models with stability ratings)
  fallback_models: [],              // Array of fallback model IDs (up to 3)
  switch_threshold: 60,             // Switch away when active model rating drops below this
  recovery_threshold: 80,           // Return to primary when its rating recovers above this
  // v10.0 Persistent Memory (Events API)
  persistent_memory_enabled: false,
  persistent_memory_src_base: '',
  persistent_memory_src_suffix: '',
  persistent_memory_src: ''
};

function readSync() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(DEFAULTS, (items) => {
      resolve({
        // Secrets are NOT read from sync — they live in chrome.storage.local only
        user_email: items[KEY_EMAIL] || '',
        model: items[KEY_MODEL] || DEFAULTS.model,
        provider: items[KEY_PROVIDER] || DEFAULTS.provider,
        api_base_url: items[KEY_API_BASE] || '',
        temperature: typeof items[KEY_TEMP] === 'number' ? items[KEY_TEMP] : DEFAULTS.temperature,
        reasoning: items[KEY_REAS] || DEFAULTS.reasoning,
        step_cap: typeof items[KEY_STEPCAP] === 'number' ? items[KEY_STEPCAP] : DEFAULTS.step_cap,
        user_context: items[KEY_USERCTX] || '',
        remote_config_url: items[KEY_REMOTECFG] || '',
        // v3.0
        cdp_input_mode: items[KEY_CDP_INPUT] !== undefined ? !!items[KEY_CDP_INPUT] : DEFAULTS.cdp_input_mode,
        spa_network_idle_ms: typeof items[KEY_SPA_NETIDLE] === 'number' ? items[KEY_SPA_NETIDLE] : DEFAULTS.spa_network_idle_ms,
        spa_dom_stable_ms: typeof items[KEY_SPA_DOMSTABLE] === 'number' ? items[KEY_SPA_DOMSTABLE] : DEFAULTS.spa_dom_stable_ms,
        agent_viewport_width: typeof items[KEY_VIEWPORT_W] === 'number' ? items[KEY_VIEWPORT_W] : DEFAULTS.agent_viewport_width,
        agent_viewport_height: typeof items[KEY_VIEWPORT_H] === 'number' ? items[KEY_VIEWPORT_H] : DEFAULTS.agent_viewport_height,
        // v3.1
        wait_timeout_default: typeof items[KEY_WAIT_TIMEOUT] === 'number' ? items[KEY_WAIT_TIMEOUT] : DEFAULTS.wait_timeout_default,
        wait_error_detection: items[KEY_WAIT_ERROR_DETECT] !== undefined ? !!items[KEY_WAIT_ERROR_DETECT] : DEFAULTS.wait_error_detection,
        wait_progress_stall_threshold: typeof items[KEY_WAIT_STALL_THRESHOLD] === 'number' ? items[KEY_WAIT_STALL_THRESHOLD] : DEFAULTS.wait_progress_stall_threshold,
        // v4.0 batch mode
        action_delay_ms: typeof items[KEY_ACTION_DELAY] === 'number' ? items[KEY_ACTION_DELAY] : DEFAULTS.action_delay_ms,
        max_actions_per_session: typeof items[KEY_MAX_ACTIONS] === 'number' ? items[KEY_MAX_ACTIONS] : DEFAULTS.max_actions_per_session,
        autonomy_mode: items[KEY_AUTONOMY] || DEFAULTS.autonomy_mode,
        // v6.0 Micro-loop & self-healing
        batch_steps_per_item: typeof items[KEY_BATCH_STEPS] === 'number' ? items[KEY_BATCH_STEPS] : DEFAULTS.batch_steps_per_item,
        ad_domain_blocklist: items[KEY_AD_BLOCKLIST] || DEFAULTS.ad_domain_blocklist,
        // v5.1 ProTalk file server
        protalk_upload_token: items[KEY_UPLOAD_TOKEN] || '',
        // v8.0 Token budget
        token_limit: typeof items[KEY_TOKEN_LIMIT] === 'number' ? items[KEY_TOKEN_LIMIT] : DEFAULTS.token_limit,
        // v9.0 Sleep mode
        sleep_poll_interval_ms: typeof items[KEY_SLEEP_POLL_INTERVAL] === 'number' ? items[KEY_SLEEP_POLL_INTERVAL] : DEFAULTS.sleep_poll_interval_ms,
        sleep_max_duration_ms: typeof items[KEY_SLEEP_MAX_DURATION] === 'number' ? items[KEY_SLEEP_MAX_DURATION] : DEFAULTS.sleep_max_duration_ms,
        // v9.1 Deep sleep (hibernation)
        deep_sleep_poll_interval_ms: typeof items[KEY_DEEP_SLEEP_POLL_INTERVAL] === 'number' ? items[KEY_DEEP_SLEEP_POLL_INTERVAL] : DEFAULTS.deep_sleep_poll_interval_ms,
        deep_sleep_max_duration_ms: typeof items[KEY_DEEP_SLEEP_MAX_DURATION] === 'number' ? items[KEY_DEEP_SLEEP_MAX_DURATION] : DEFAULTS.deep_sleep_max_duration_ms,
        // v9.2 Anti-Blink (fast-track for custom dropdowns)
        fast_track_delay_ms: typeof items[KEY_FAST_TRACK_DELAY] === 'number' ? items[KEY_FAST_TRACK_DELAY] : DEFAULTS.fast_track_delay_ms,
        // v9.3 Human-like mouse movement (Bezier interpolation)
        mouse_move_jitter: typeof items[KEY_MOUSE_MOVE_JITTER] === 'number' ? items[KEY_MOUSE_MOVE_JITTER] : DEFAULTS.mouse_move_jitter,
        mouse_move_base_delay: typeof items[KEY_MOUSE_MOVE_BASE_DELAY] === 'number' ? items[KEY_MOUSE_MOVE_BASE_DELAY] : DEFAULTS.mouse_move_base_delay,
        // v11.0 Model Rotation (fallback models)
        fallback_models: Array.isArray(items[KEY_FALLBACK_MODELS]) ? items[KEY_FALLBACK_MODELS].slice(0, 3) : DEFAULTS.fallback_models,
        switch_threshold: typeof items[KEY_SWITCH_THRESHOLD] === 'number' ? items[KEY_SWITCH_THRESHOLD] : DEFAULTS.switch_threshold,
        recovery_threshold: typeof items[KEY_RECOVERY_THRESHOLD] === 'number' ? items[KEY_RECOVERY_THRESHOLD] : DEFAULTS.recovery_threshold,
        // v10.0 Persistent Memory (Events API)
        persistent_memory_enabled: items[KEY_PMEM_ENABLED] !== undefined ? !!items[KEY_PMEM_ENABLED] : DEFAULTS.persistent_memory_enabled,
        persistent_memory_src_base: items[KEY_PMEM_SRC_BASE] || '',
        persistent_memory_src_suffix: items[KEY_PMEM_SRC_SUFFIX] || '',
        persistent_memory_src: items[KEY_PMEM_SRC] || ''
      });
    });
  });
}

/** Read secrets from chrome.storage.local (device-local, never synced). */
function readLocalSecrets() {
  return new Promise((resolve) => {
    chrome.storage.local.get([KEY_TOKEN, KEY_API_KEY], (items) => {
      resolve({
        auth_token: items[KEY_TOKEN] || '',
        api_key: items[KEY_API_KEY] || ''
      });
    });
  });
}

function readLocalCache() {
  return new Promise((resolve) => {
    chrome.storage.local.get(['settings_cache'], (items) => {
      resolve(items.settings_cache || null);
    });
  });
}

function writeLocalCache(s) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ settings_cache: s }, () => resolve());
  });
}

export async function getSettings() {
  const base = await readSync();
  const secrets = await readLocalSecrets();
  // Merge: secrets from local storage override sync (where they no longer live)
  const withSecrets = { ...base, ...stripEmpty(secrets) };

  const remoteUrl = base.remote_config_url;
  if (remoteUrl) {
    try {
      const remote = await fetchRemoteConfig(remoteUrl);
      if (remote) {
        // merge: remote fills empty fields, never overwrites populated ones locally
        // IMPORTANT: remote config is NEVER allowed to import secrets
        delete remote.auth_token;
        delete remote.api_key;
        const merged = { ...remote, ...stripEmpty(withSecrets) };
        // Mirror to local cache so we have something even if remote is down
        writeLocalCache(merged);
        return merged;
      }
    } catch (e) {
      // Remote failed → fall back to local cache, then to sync
      const cached = await readLocalCache();
      if (cached) return { ...cached, ...stripEmpty(withSecrets) };
    }
  }
  return withSecrets;
}

export function setSettings(partial) {
  return new Promise((resolve) => {
    const syncPatch = {};
    const localPatch = {};

    // Secrets go to chrome.storage.local (device-local, never synced)
    if (partial.auth_token !== undefined) localPatch[KEY_TOKEN] = partial.auth_token;
    if (partial.api_key !== undefined) localPatch[KEY_API_KEY] = partial.api_key;
    if (partial.protalk_upload_token !== undefined) localPatch[KEY_UPLOAD_TOKEN] = partial.protalk_upload_token;

    // Everything else goes to chrome.storage.sync
    if (partial.user_email !== undefined) syncPatch[KEY_EMAIL] = partial.user_email;
    if (partial.model !== undefined) syncPatch[KEY_MODEL] = partial.model;
    if (partial.provider !== undefined) syncPatch[KEY_PROVIDER] = partial.provider;
    if (partial.api_base_url !== undefined) syncPatch[KEY_API_BASE] = partial.api_base_url;
    if (partial.temperature !== undefined) syncPatch[KEY_TEMP] = partial.temperature;
    if (partial.reasoning !== undefined) syncPatch[KEY_REAS] = partial.reasoning;
    if (partial.step_cap !== undefined) syncPatch[KEY_STEPCAP] = partial.step_cap;
    if (partial.user_context !== undefined) syncPatch[KEY_USERCTX] = partial.user_context;
    if (partial.remote_config_url !== undefined) syncPatch[KEY_REMOTECFG] = partial.remote_config_url;
    // v3.0
    if (partial.cdp_input_mode !== undefined) syncPatch[KEY_CDP_INPUT] = !!partial.cdp_input_mode;
    if (partial.spa_network_idle_ms !== undefined) syncPatch[KEY_SPA_NETIDLE] = Math.max(100, Math.min(5000, partial.spa_network_idle_ms));
    if (partial.spa_dom_stable_ms !== undefined) syncPatch[KEY_SPA_DOMSTABLE] = Math.max(50, Math.min(3000, partial.spa_dom_stable_ms));
    if (partial.agent_viewport_width !== undefined) syncPatch[KEY_VIEWPORT_W] = Math.max(320, Math.min(3840, partial.agent_viewport_width));
    if (partial.agent_viewport_height !== undefined) syncPatch[KEY_VIEWPORT_H] = Math.max(240, Math.min(2160, partial.agent_viewport_height));
    // v3.1
    if (partial.wait_timeout_default !== undefined) syncPatch[KEY_WAIT_TIMEOUT] = Math.max(10000, Math.min(600000, partial.wait_timeout_default));
    if (partial.wait_error_detection !== undefined) syncPatch[KEY_WAIT_ERROR_DETECT] = !!partial.wait_error_detection;
    if (partial.wait_progress_stall_threshold !== undefined) syncPatch[KEY_WAIT_STALL_THRESHOLD] = Math.max(3, Math.min(100, partial.wait_progress_stall_threshold));

    // v4.0 batch mode
    if (partial.action_delay_ms !== undefined) syncPatch[KEY_ACTION_DELAY] = Math.max(500, Math.min(30000, partial.action_delay_ms));
    if (partial.max_actions_per_session !== undefined) syncPatch[KEY_MAX_ACTIONS] = Math.max(1, Math.min(500, partial.max_actions_per_session));
    if (partial.autonomy_mode !== undefined) syncPatch[KEY_AUTONOMY] = partial.autonomy_mode === 'safe' ? 'safe' : 'full';

    // v6.0 Micro-loop & self-healing
    if (partial.batch_steps_per_item !== undefined) syncPatch[KEY_BATCH_STEPS] = Math.max(1, Math.min(20, partial.batch_steps_per_item));
    if (partial.ad_domain_blocklist !== undefined) syncPatch[KEY_AD_BLOCKLIST] = String(partial.ad_domain_blocklist || '');

    // v8.0 Token budget
    if (partial.token_limit !== undefined) syncPatch[KEY_TOKEN_LIMIT] = Math.max(1000, Math.min(50000000, partial.token_limit));

    // v9.0 Sleep mode
    if (partial.sleep_poll_interval_ms !== undefined) syncPatch[KEY_SLEEP_POLL_INTERVAL] = Math.max(1000, Math.min(30000, partial.sleep_poll_interval_ms));
    if (partial.sleep_max_duration_ms !== undefined) syncPatch[KEY_SLEEP_MAX_DURATION] = Math.max(30000, Math.min(3600000, partial.sleep_max_duration_ms));

    // v9.1 Deep sleep (hibernation)
    if (partial.deep_sleep_poll_interval_ms !== undefined) syncPatch[KEY_DEEP_SLEEP_POLL_INTERVAL] = Math.max(2000, Math.min(60000, partial.deep_sleep_poll_interval_ms));
    if (partial.deep_sleep_max_duration_ms !== undefined) syncPatch[KEY_DEEP_SLEEP_MAX_DURATION] = Math.max(60000, Math.min(172800000, partial.deep_sleep_max_duration_ms));

    // v9.2 Anti-Blink (fast-track for custom dropdowns)
    if (partial.fast_track_delay_ms !== undefined) syncPatch[KEY_FAST_TRACK_DELAY] = Math.max(0, Math.min(500, partial.fast_track_delay_ms));

    // v9.3 Human-like mouse movement (Bezier interpolation)
    if (partial.mouse_move_jitter !== undefined) syncPatch[KEY_MOUSE_MOVE_JITTER] = Math.max(0, Math.min(10, partial.mouse_move_jitter));
    if (partial.mouse_move_base_delay !== undefined) syncPatch[KEY_MOUSE_MOVE_BASE_DELAY] = Math.max(0, Math.min(50, partial.mouse_move_base_delay));

    // v11.0 Model Rotation (fallback models)
    if (partial.fallback_models !== undefined) syncPatch[KEY_FALLBACK_MODELS] = Array.isArray(partial.fallback_models) ? partial.fallback_models.filter(Boolean).slice(0, 3) : [];
    if (partial.switch_threshold !== undefined) syncPatch[KEY_SWITCH_THRESHOLD] = Math.max(10, Math.min(90, partial.switch_threshold));
    if (partial.recovery_threshold !== undefined) syncPatch[KEY_RECOVERY_THRESHOLD] = Math.max(30, Math.min(100, partial.recovery_threshold));

    // v10.0 Persistent Memory (Events API)
    if (partial.persistent_memory_enabled !== undefined) syncPatch[KEY_PMEM_ENABLED] = !!partial.persistent_memory_enabled;
    if (partial.persistent_memory_src_base !== undefined) syncPatch[KEY_PMEM_SRC_BASE] = String(partial.persistent_memory_src_base || '').slice(0, 100);
    if (partial.persistent_memory_src_suffix !== undefined) syncPatch[KEY_PMEM_SRC_SUFFIX] = String(partial.persistent_memory_src_suffix || '').slice(0, 20);
    if (partial.persistent_memory_src !== undefined) syncPatch[KEY_PMEM_SRC] = String(partial.persistent_memory_src || '').slice(0, 140);

    // Write both stores in parallel
    let done = 0;
    const finish = () => { if (++done >= 2) resolve({ ok: true }); };
    if (Object.keys(localPatch).length) {
      chrome.storage.local.set(localPatch, finish);
    } else {
      finish();
    }
    if (Object.keys(syncPatch).length) {
      chrome.storage.sync.set(syncPatch, finish);
    } else {
      finish();
    }
  });
}

export function clearSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.clear(() => {
      chrome.storage.local.remove([KEY_TOKEN, KEY_API_KEY, 'settings_cache'], () => resolve({ ok: true }));
    });
  });
}

function stripEmpty(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== '' && v != null) out[k] = v;
  }
  return out;
}

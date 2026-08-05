// remote_config.js — fetch settings from a remote URL.
// Supports direct CORS-enabled JSON endpoint (e.g. raw GitHub Gist, raw.githubusercontent.com).
//
// SECURITY: Secrets (auth_token, api_key) are NEVER imported from remote config.
// They live exclusively in chrome.storage.local (device-local, never synced).
//
// Returned shape (any field may be omitted):
//   {
//     "user_email": "...",
//     "provider": "openai",
//     "api_base_url": "https://openrouter.ai/api/v1",
//     "model": "openai/gpt-4o",
//     "temperature": 0.2,
//     "reasoning": "low",
//     "step_cap": 200,
//     "user_context": "...",
//     "cdp_input_mode": true,
//     "spa_network_idle_ms": 500,
//     "spa_dom_stable_ms": 300,
//     "agent_viewport_width": 1280,
//     "agent_viewport_height": 800
//   }

// NOTE: auth_token and api_key are intentionally EXCLUDED from KNOWN_KEYS.
// Secrets must never be imported from public remote configs (Gist, etc.).
const KNOWN_KEYS = [
  'user_email', 'model', 'provider', 'api_base_url',
  'temperature', 'reasoning', 'step_cap', 'user_context',
  'cdp_input_mode',
  'spa_network_idle_ms', 'spa_dom_stable_ms',
  'agent_viewport_width', 'agent_viewport_height'
];

export async function fetchRemoteConfig(url) {
  if (!url) return null;
  const clean = String(url).trim();
  if (!/^https?:\/\//i.test(clean)) return null;

  // Direct fetch only — NO corsproxy fallback (would leak secrets to third-party proxy)
  let text = null;
  try {
    const r = await fetch(clean, { method: 'GET', cache: 'no-store' });
    if (r.ok) {
      text = await r.text();
    }
  } catch (_) { /* fetch failed */ }

  if (text == null) return null;

  let parsed;
  try { parsed = JSON.parse(text); }
  catch (e) { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  // Filter to known keys only — secrets are silently dropped
  const out = {};
  for (const k of KNOWN_KEYS) {
    if (parsed[k] !== undefined) out[k] = parsed[k];
  }
  return out;
}

// Probe whether the URL is reachable and returns a valid config object.
// Returns { ok: true, config } or { ok: false, error }
export async function probeRemoteConfig(url) {
  try {
    const cfg = await fetchRemoteConfig(url);
    if (!cfg) return { ok: false, error: 'empty_or_invalid' };
    return { ok: true, config: cfg };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

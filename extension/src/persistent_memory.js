// persistent_memory.js — Events API backed long-term memory for WebClaw

const EVENTS_BASE = 'https://events.atiks.org';
const MEMORY_TYPE = 'memory';

export function generateMemorySuffix(length = 6) {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

export function sanitizeSrcBase(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

export function buildMemorySrc(settings = {}) {
  if (settings.persistent_memory_src) return String(settings.persistent_memory_src).trim();
  const base = sanitizeSrcBase(settings.persistent_memory_src_base || 'webclaw');
  const suffix = String(settings.persistent_memory_src_suffix || '').trim();
  if (!base) return '';
  return suffix ? `${base}_${suffix}` : base;
}

function normalizeFieldValue(key, value) {
  if (value == null) return '';
  let v = String(value);
  if (key === 'email') v = v.trim().toLowerCase();
  if (key === 'site' || key === 'domain') {
    v = v.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
  return v.slice(0, 1000);
}

function normalizeFields(fields = {}) {
  const out = {};
  for (const [k, v] of Object.entries(fields || {})) {
    const key = String(k || '').trim().replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 80);
    if (!key) continue;
    out[key] = normalizeFieldValue(key, v);
  }
  if (out.url && !out.domain) {
    try { out.domain = new URL(out.url).hostname.toLowerCase().replace(/^www\./, ''); } catch (_) {}
  }
  return out;
}

function appendParams(url, params) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
}

export async function rememberEvent(settings, payload = {}, context = {}) {
  if (!settings?.persistent_memory_enabled) return { ok: false, error: 'persistent_memory_disabled' };
  const src = buildMemorySrc(settings);
  if (!src) return { ok: false, error: 'persistent_memory_src_missing' };

  const fields = normalizeFields(payload.fields || payload);
  const kind = String(payload.kind || fields.kind || 'note').slice(0, 80);
  const url = new URL(EVENTS_BASE + '/e');
  appendParams(url, {
    src,
    type: MEMORY_TYPE,
    kind,
    created_at: new Date().toISOString(),
    current_url: context.currentUrl || '',
    page_title: context.pageTitle || '',
    //task: context.task || '',
    ...fields
  });

  const res = await fetch(url.toString(), { method: 'GET' });
  const text = await res.text().catch(() => '');
  if (!res.ok) return { ok: false, error: `http_${res.status}`, response: text.slice(0, 300) };
  return { ok: true, src, kind, fields, response: text.slice(0, 300) };
}

export async function recallEvents(settings, query = {}) {
  if (!settings?.persistent_memory_enabled) return { ok: false, error: 'persistent_memory_disabled' };
  const src = buildMemorySrc(settings);
  if (!src) return { ok: false, error: 'persistent_memory_src_missing' };

  const limit = Math.max(1, Math.min(50, parseInt(query.limit, 10) || 10));
  const filters = Array.isArray(query.filters) ? query.filters : [];
  const normalizedFilters = filters
    .filter(f => f && f.field && f.op)
    .map(f => ({ field: String(f.field), op: String(f.op), value: String(f.value ?? '') }));
  if (query.kind) normalizedFilters.unshift({ field: 'kind', op: 'eq', value: String(query.kind) });

  const url = new URL(EVENTS_BASE + '/s');
  appendParams(url, { src, type: MEMORY_TYPE, group: 'raw', limit });
  if (normalizedFilters.length) url.searchParams.set('filters', JSON.stringify(normalizedFilters));

  const res = await fetch(url.toString(), { method: 'GET' });
  const text = await res.text();
  if (!res.ok) return { ok: false, error: `http_${res.status}`, response: text.slice(0, 500) };

  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  const items = extractItems(data).slice(0, limit);
  return { ok: true, src, found: items.length > 0, count: items.length, items, rawShape: Array.isArray(data) ? 'array' : typeof data };
}

function extractItems(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.rows)) return data.rows;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.events)) return data.events;
  return data && typeof data === 'object' ? [data] : [];
}

export async function fetchAllMemory(settings) {
  const src = buildMemorySrc(settings);
  if (!src) throw new Error('persistent_memory_src_missing');
  const url = new URL(EVENTS_BASE + '/s');
  appendParams(url, { src, type: MEMORY_TYPE, group: 'raw', limit: 500 });
  const res = await fetch(url.toString(), { method: 'GET' });
  const text = await res.text();
  if (!res.ok) throw new Error(`Events API HTTP ${res.status}: ${text.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(text); } catch (_) { data = text; }
  return extractItems(data);
}

export function toCsv(rows) {
  const arr = Array.isArray(rows) ? rows : [];
  const columns = Array.from(arr.reduce((set, row) => {
    if (row && typeof row === 'object') Object.keys(row).forEach(k => set.add(k));
    return set;
  }, new Set()));
  if (!columns.length) return 'empty\n';
  const esc = (v) => {
    const s = v == null ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return /["\n,;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [columns.join(','), ...arr.map(row => columns.map(c => esc(row?.[c])).join(','))].join('\n');
}

export async function exportMemoryCsv(settings) {
  const rows = await fetchAllMemory(settings);
  return { rows, csv: toCsv(rows), src: buildMemorySrc(settings) };
}

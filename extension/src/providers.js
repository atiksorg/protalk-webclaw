// providers.js — Provider Abstraction Layer for AI model calls.
//
// Each provider implements a single method:
//   callModel(settings, userText, imageDataUrl, onTaskCreated, sessionLogger) → { content, reasoning }
//
// Providers:
//   - ProTalkProvider:  ProTalk async router (task_id + polling) — legacy default
//   - OpenAIProvider:   OpenAI-compatible API (OpenRouter, any compatible endpoint)
//   - AnthropicProvider: Anthropic Messages API (Claude models)
//   - OllamaProvider:   Local Ollama server (http://localhost:11434)
//
// Session Logging: when a sessionLogger (SessionLogger instance) is passed,
// each provider logs the API call details (CURL format, request/response bodies,
// status codes, duration) for debugging and HTML report generation.

import { broadcast } from './bus.js';
import { uploadScreenshot, isDataUrl } from './file_upload.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Abortable sleep: resolves early if abortCheck() returns true.
 * @param {number} ms - Duration in ms
 * @param {Function} [abortCheck] - () => boolean, throws if true
 */
async function abortableSleep(ms, abortCheck) {
  const checkInterval = 300; // check every 300ms
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (abortCheck && abortCheck()) throw new Error('aborted');
    await sleep(Math.min(checkInterval, ms - (Date.now() - start)));
  }
}

/**
 * Log API call to session logger AND broadcast to real-time UI.
 * This ensures API calls appear in logs/monitor instantly.
 */
function logApiCallAndBroadcast(sessionLogger, data) {
  if (sessionLogger) sessionLogger.logApiCall(data);
  broadcast({ kind: 'api_call', ...data });
}

// ============================================================
// HELPER: build multimodal content array from prompt + image
// ============================================================

function buildMessages(userText, imageDataUrl) {
  // Most providers accept text-only or text+image messages.
  // We return the raw messages array — each provider restructures as needed.
  return [{ role: 'user', content: userText }];
}

function buildMultimodalMessages(userText, imageDataUrl, systemPrompt) {
  const messages = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (!imageDataUrl) {
    messages.push({ role: 'user', content: userText });
  } else {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userText },
        { type: 'image_url', image_url: { url: imageDataUrl } }
      ]
    });
  }
  return messages;
}

// ============================================================
// ProTalk Async Provider (legacy)
// ============================================================

class ProTalkProvider {
  constructor() {
    this.name = 'ProTalk';
    this.baseUrl = 'https://ai.pro-talk.ru/api/async/router';
  }

  async callModel(settings, userText, imageDataUrl, onTaskCreated, sessionLogger, abortCheck, systemPrompt) {
    const content = [{ type: 'text', text: userText }];
    if (imageDataUrl) {
      // Upload screenshot to file server and get public URL
      let imageUrl = imageDataUrl;
      try {
        if (isDataUrl(imageDataUrl)) {
          imageUrl = await uploadScreenshot(imageDataUrl);
        }
      } catch (e) {
        // Fall back to original data URL if upload fails
        console.warn('Screenshot upload failed, using data URL:', e.message);
      }
      content.push({ type: 'image_url', image_url: { url: imageUrl } });
    }
    const payload = {
      base_url: 'https://openrouter.ai/api/v1/chat/completions',
      platform: 'ProTalk',
      user_email: settings.user_email,
      model: settings.model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content }
      ],
      temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.2,
      reasoning: { effort: settings.reasoning || 'low' },
      stream: false
    };

    const authToken = settings.auth_token || settings.api_key;
    const headers = {
      'Authorization': 'Bearer ' + authToken,
      'Content-Type': 'application/json'
    };
    const startTime = Date.now();
    let responseStatus = null;
    let responseBody = null;
    let errorStr = null;

    const r = await fetch(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload)
    });
    responseStatus = r.status;

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      responseBody = txt;
      errorStr = `HTTP ${r.status}: ${txt.slice(0, 200)}`;
      // Log failed API call
      logApiCallAndBroadcast(sessionLogger, {
        provider: this.name, url: this.baseUrl, method: 'POST', headers,
        body: payload, response: responseBody, responseStatus,
        error: errorStr, durationMs: Date.now() - startTime
      });
      if (r.status === 429 || r.status >= 500) {
        const err = new Error('create_task_http_' + r.status);
        err.transient = true;
        throw err;
      }
      throw new Error('create_task_http_' + r.status + ': ' + txt.slice(0, 200));
    }
    const j = await r.json();
    responseBody = j;

    // Log the create-task call
    logApiCallAndBroadcast(sessionLogger, {
      provider: this.name, url: this.baseUrl, method: 'POST', headers,
      body: payload, response: j, responseStatus,
      durationMs: Date.now() - startTime
    });

    if (!j.task_id) throw new Error('create_task_no_task_id: ' + JSON.stringify(j).slice(0, 200));

    if (onTaskCreated) onTaskCreated(j.task_id);

    // Poll for result
    return await this._poll(authToken, j.task_id, sessionLogger, abortCheck);
  }

  async _poll(authToken, taskId, sessionLogger, abortCheck) {
    const url = `${this.baseUrl}/${taskId}`;
    const headers = { 'Authorization': 'Bearer ' + authToken };
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      // Abort check at the top of every polling iteration
      if (abortCheck && abortCheck()) throw new Error('aborted');
      const startTime = Date.now();
      const r = await fetch(url, { headers });
      if (!r.ok) {
        if (r.status === 429 || r.status >= 500) {
          logApiCallAndBroadcast(sessionLogger, {
            provider: this.name, url, method: 'GET', headers,
            responseStatus: r.status, error: `HTTP ${r.status}`,
            durationMs: Date.now() - startTime
          });
          // Abortable wait between retries
          await abortableSleep(2000, abortCheck);
          continue;
        }
        throw new Error('poll_http_' + r.status);
      }
      const j = await r.json();
      logApiCallAndBroadcast(sessionLogger, {
        provider: this.name, url, method: 'GET', headers,
        response: j, responseStatus: r.status,
        durationMs: Date.now() - startTime
      });
      if (j.status === 'completed') {
        const msg = j.result?.choices?.[0]?.message;
        const tokensUsed = j.result?.usage?.total_tokens || 0;
        return { content: msg?.content || '', reasoning: msg?.reasoning || '', tokensUsed };
      }
      if (j.status === 'failed') {
        throw new Error('task_failed: ' + JSON.stringify(j).slice(0, 300));
      }
      // Abortable wait between polls
      await abortableSleep(1500, abortCheck);
    }
    throw new Error('poll_timeout');
  }
}

// ============================================================
// OpenAI-compatible Provider (works with OpenRouter, any endpoint)
// ============================================================

class OpenAIProvider {
  constructor() {
    this.name = 'OpenAI';
  }

  async callModel(settings, userText, imageDataUrl, onTaskCreated, sessionLogger, abortCheck, systemPrompt) {
    const baseUrl = (settings.api_base_url || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const apiKey = settings.api_key || settings.auth_token;
    
    // Upload screenshot if it's a data URL
    let processedImageUrl = imageDataUrl;
    if (imageDataUrl && isDataUrl(imageDataUrl)) {
      try {
        processedImageUrl = await uploadScreenshot(imageDataUrl);
      } catch (e) {
        console.warn('Screenshot upload failed, using data URL:', e.message);
      }
    }
    
    const messages = buildMultimodalMessages(userText, processedImageUrl, systemPrompt);

    const body = {
      model: settings.model,
      messages,
      temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.2,
      stream: false
    };

    // Add reasoning effort if model supports it (OpenRouter extension)
    if (settings.reasoning) {
      body.reasoning = { effort: settings.reasoning };
    }

    const url = `${baseUrl}/chat/completions`;
    const headers = {
      'Authorization': 'Bearer ' + apiKey,
      'Content-Type': 'application/json'
    };
    const startTime = Date.now();

    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      logApiCallAndBroadcast(sessionLogger, {
        provider: this.name, url, method: 'POST', headers,
        body, response: txt, responseStatus: r.status,
        error: `HTTP ${r.status}: ${txt.slice(0, 200)}`,
        durationMs: Date.now() - startTime
      });
      if (r.status === 429 || r.status >= 500) {
        const err = new Error('openai_http_' + r.status);
        err.transient = true;
        throw err;
      }
      throw new Error('openai_http_' + r.status + ': ' + txt.slice(0, 200));
    }

    const j = await r.json();
    const msg = j.choices?.[0]?.message;
    const tokensUsed = j.usage?.total_tokens || 0;
    const result = { content: msg?.content || '', reasoning: msg?.reasoning || '', tokensUsed };

    logApiCallAndBroadcast(sessionLogger, {
      provider: this.name, url, method: 'POST', headers,
      body, response: j, responseStatus: r.status,
      durationMs: Date.now() - startTime
    });

    return result;
  }
}

// ============================================================
// Anthropic Provider (Claude models via Messages API)
// ============================================================

class AnthropicProvider {
  constructor() {
    this.name = 'Anthropic';
    this.baseUrl = 'https://api.anthropic.com';
  }

  async callModel(settings, userText, imageDataUrl, onTaskCreated, sessionLogger, abortCheck, systemPrompt) {
    const apiKey = settings.api_key || settings.auth_token;
    const model = settings.model.replace('anthropic/', ''); // strip provider prefix if present

    // Anthropic uses a different message format
    const content = [{ type: 'text', text: userText }];
    if (imageDataUrl) {
      // Upload screenshot to file server and get public URL
      let imageUrl = imageDataUrl;
      try {
        if (isDataUrl(imageDataUrl)) {
          imageUrl = await uploadScreenshot(imageDataUrl);
        }
      } catch (e) {
        console.warn('Screenshot upload failed, using data URL:', e.message);
      }
      
      // Anthropic supports URL type for images
      content.unshift({
        type: 'image',
        source: { type: 'url', url: imageUrl }
      });
    }

    const body = {
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content }],
      temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.2
    };

    // Anthropic uses a top-level 'system' field (not a system message in the array)
    if (systemPrompt) {
      body.system = systemPrompt;
    }

    const url = `${this.baseUrl}/v1/messages`;
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    };
    const startTime = Date.now();

    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      logApiCallAndBroadcast(sessionLogger, {
        provider: this.name, url, method: 'POST', headers,
        body, response: txt, responseStatus: r.status,
        error: `HTTP ${r.status}: ${txt.slice(0, 200)}`,
        durationMs: Date.now() - startTime
      });
      if (r.status === 429 || r.status >= 500) {
        const err = new Error('anthropic_http_' + r.status);
        err.transient = true;
        throw err;
      }
      throw new Error('anthropic_http_' + r.status + ': ' + txt.slice(0, 200));
    }

    const j = await r.json();
    // Anthropic returns content as array of blocks
    const textBlock = (j.content || []).find(b => b.type === 'text');
    // Anthropic returns usage.input_tokens + usage.output_tokens (no total_tokens)
    const tokensUsed = (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0);
    const result = { content: textBlock?.text || '', reasoning: '', tokensUsed };

    logApiCallAndBroadcast(sessionLogger, {
      provider: this.name, url, method: 'POST', headers,
      body, response: j, responseStatus: r.status,
      durationMs: Date.now() - startTime
    });

    return result;
  }
}

// ============================================================
// Ollama Provider (local, works offline)
// ============================================================

class OllamaProvider {
  constructor() {
    this.name = 'Ollama';
    this.defaultBaseUrl = 'http://localhost:11434';
  }

  async callModel(settings, userText, imageDataUrl, onTaskCreated, sessionLogger, abortCheck, systemPrompt) {
    const baseUrl = (settings.api_base_url || this.defaultBaseUrl).replace(/\/+$/, '');
    const model = settings.model.replace(/^ollama\//i, ''); // strip prefix

    // Ollama /api/chat format
    const messages = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    const message = { role: 'user', content: userText };
    if (imageDataUrl) {
      // Ollama accepts base64 images in the images array
      const match = imageDataUrl.match(/^data:image\/\w+;base64,(.+)$/);
      if (match) {
        message.images = [match[1]];
      }
    }
    messages.push(message);

    const body = {
      model,
      messages,
      stream: false,
      options: {
        temperature: typeof settings.temperature === 'number' ? settings.temperature : 0.2
      }
    };

    const url = `${baseUrl}/api/chat`;
    const headers = { 'Content-Type': 'application/json' };
    const startTime = Date.now();

    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });

    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      logApiCallAndBroadcast(sessionLogger, {
        provider: this.name, url, method: 'POST', headers,
        body, response: txt, responseStatus: r.status,
        error: `HTTP ${r.status}: ${txt.slice(0, 200)}`,
        durationMs: Date.now() - startTime
      });
      if (r.status === 429 || r.status >= 500) {
        const err = new Error('ollama_http_' + r.status);
        err.transient = true;
        throw err;
      }
      throw new Error('ollama_http_' + r.status + ': ' + txt.slice(0, 200));
    }

    const j = await r.json();
    // Ollama returns eval_count (output) and prompt_eval_count (input) in the response root
    const tokensUsed = (j.prompt_eval_count || 0) + (j.eval_count || 0);
    const result = { content: j.message?.content || '', reasoning: '', tokensUsed };

    logApiCallAndBroadcast(sessionLogger, {
      provider: this.name, url, method: 'POST', headers,
      body, response: j, responseStatus: r.status,
      durationMs: Date.now() - startTime
    });

    return result;
  }
}

// ============================================================
// Provider Registry
// ============================================================

const PROVIDERS = {
  protalk:  ProTalkProvider,
  openai:   OpenAIProvider,
  anthropic: AnthropicProvider,
  ollama:   OllamaProvider
};

/**
 * Get the appropriate provider instance based on settings.
 * Auto-detection: if no provider is explicitly set, infer from model name.
 */
export function getProvider(settings) {
  let providerKey = settings.provider;

  // Auto-detect from model name if provider not explicitly set
  if (!providerKey) {
    const model = (settings.model || '').toLowerCase();
    if (model.startsWith('anthropic/') || model.startsWith('claude')) {
      providerKey = 'anthropic';
    } else if (model.includes('localhost') || model.startsWith('ollama/')) {
      providerKey = 'ollama';
    } else {
      providerKey = 'protalk'; // default legacy
    }
  }

  const ProviderClass = PROVIDERS[providerKey] || ProTalkProvider;
  return new ProviderClass();
}

/**
 * Call model with retry/backoff logic (provider-agnostic).
 * This replaces the old callModelWithBackoff() in background.js.
 *
 * @param {Object} settings
 * @param {string} userText
 * @param {string|null} imageDataUrl
 * @param {Object} opts - { onTaskCreated, onLog, abortCheck, sessionLogger }
 *   abortCheck: () => boolean — checked before each API call, between retries,
 *               and inside polling loops (ProTalk) so that "Stop" interrupts immediately.
 */
export async function callModelWithBackoff(settings, userText, imageDataUrl, { onTaskCreated, onLog, abortCheck, sessionLogger, systemPrompt } = {}) {
  const provider = getProvider(settings);
  let attempt = 0;
  let lastErr;

  while (attempt < 4) {
    if (abortCheck && abortCheck()) throw new Error('aborted');
    try {
      const result = await provider.callModel(settings, userText, imageDataUrl, onTaskCreated, sessionLogger, abortCheck, systemPrompt);
      return result;
    } catch (e) {
      lastErr = e;
      if (e.message === 'aborted') throw e; // Never retry on abort
      if (!e.transient && !/poll_timeout|create_task_no_task_id/.test(e.message)) {
        throw e;
      }
      attempt++;
      const wait = Math.min(15000, 1500 * Math.pow(2, attempt));
      if (onLog) onLog(`retry in ${wait}ms: ${e.message}`);
      // Abortable sleep between retries
      await abortableSleep(wait, abortCheck);
    }
  }
  throw lastErr || new Error('unknown_api_error');
}

/**
 * Test the connection for a given provider/settings combination.
 * Returns { ok: true } or { ok: false, error }.
 */
export async function testProvider(settings) {
  try {
    const provider = getProvider(settings);
    const result = await provider.callModel(settings, 'Reply with one word: pong', null);
    return { ok: true, reply: result.content.slice(0, 100), provider: provider.name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

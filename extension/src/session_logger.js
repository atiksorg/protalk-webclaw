// session_logger.js — Session logging & HTML report generation.
//
// Captures everything during an agent session:
//   - Screenshots (uploaded to file.pro-talk.ru for persistent URLs)
//   - API calls in CURL format + raw responses
//   - Agent actions & observations
//   - Session metadata (task, context, model, timestamps)
//
// Generates two outputs:
//   1. HTML report with embedded screenshots and visual step timeline
//   2. Raw API log (CURL commands + responses) as a separate file
//
// Upload uses file.pro-talk.ru API (non-confidential token).

const UPLOAD_URL = 'https://file.pro-talk.ru/ptrn';
const UPLOAD_TOKEN = 'patrins_b9b1ae83fe6d82cf301ee33b54bfb02cab62ed82b9f9a1455395bf01655dad94';

// ============================================================
// SESSION LOGGER CLASS
// ============================================================

export class SessionLogger {
  constructor() {
    this.reset();
  }

  reset() {
    this.sessionId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.startedAt = new Date();
    this.completedAt = null;
    this.task = '';
    this.context = '';
    this.model = '';
    this.provider = '';
    this.steps = [];
    this.apiCalls = [];
    this.errors = [];
    this.totalTokensUsed = 0;  // accumulated token count from AI responses
    this.screenshotUrls = new Map(); // base64data → uploaded URL
    this._uploadQueue = [];
    this._uploading = false;
  }

  // ---- Session metadata ----

  setSessionMeta({ task, context, model, provider }) {
    this.task = task || '';
    this.context = context || '';
    this.model = model || '';
    this.provider = provider || '';
  }

  complete() {
    this.completedAt = new Date();
  }

  // ---- Step logging ----

  logStep(stepData) {
    const step = {
      index: stepData.step || this.steps.length + 1,
      timestamp: new Date(),
      phase: stepData.phase || 'executing',
      screenshotDataUrl: stepData.screenshotDataUrl || null,
      screenshotUrl: null, // will be filled after upload
      pageInfo: stepData.pageInfo || {},
      prompt: stepData.prompt || '',
      modelResponse: stepData.modelResponse || '',
      parsedAction: stepData.parsedAction || null,
      observation: stepData.observation || null,
      error: stepData.error || null
    };
    this.steps.push(step);

    // Queue screenshot upload (async, non-blocking)
    if (step.screenshotDataUrl) {
      this._queueScreenshotUpload(step.index, step.screenshotDataUrl);
    }

    return step;
  }

  logError(error) {
    this.errors.push({
      timestamp: new Date(),
      message: error.message || String(error),
      stack: error.stack || ''
    });
  }

  /**
   * Accumulate token usage from an AI model response.
   * @param {number} n — number of tokens used in this call
   */
  logTokens(n) {
    if (n && n > 0) {
      this.totalTokensUsed += n;
    }
  }

  // ---- API call logging (CURL format) ----

  /**
   * Log an API call in CURL format + raw response.
   * Called by providers.js after each model API call.
   */
  logApiCall({ provider, url, method, headers, body, response, responseStatus, error, durationMs }) {
    const curl = this._buildCurl({ url, method, headers, body });
    const entry = {
      timestamp: new Date(),
      provider: provider || this.provider,
      url,
      method: method || 'POST',
      curl,
      requestHeaders: headers || {},
      requestBody: body || null,
      responseStatus: responseStatus || null,
      responseBody: response || null,
      error: error || null,
      durationMs: durationMs || 0
    };
    this.apiCalls.push(entry);
    return entry;
  }

  /**
   * Build a CURL command string from request details.
   */
  _buildCurl({ url, method, headers, body }) {
    const parts = ['curl'];
    
    // Method
    if (method && method !== 'GET') {
      parts.push(`-X ${method}`);
    }

    // Headers
    if (headers) {
      for (const [key, value] of Object.entries(headers)) {
        // Mask auth tokens for security
        let displayValue = value;
        if (key.toLowerCase() === 'authorization' || key.toLowerCase() === 'x-api-key') {
          if (typeof value === 'string' && value.length > 20) {
            displayValue = value.slice(0, 16) + '...[MASKED]';
          }
        }
        parts.push(`-H '${key}: ${displayValue}'`);
      }
    }

    // Body
    if (body) {
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body, null, 2);
      // Truncate very long bodies for readability (screenshots are base64)
      const truncated = bodyStr.length > 5000 
        ? bodyStr.slice(0, 5000) + `\n... [truncated, total ${bodyStr.length} chars]`
        : bodyStr;
      parts.push(`-d '${truncated.replace(/'/g, "'\\''")}'`);
    }

    parts.push(`'${url}'`);
    return parts.join(' \\\n  ');
  }

  // ---- Screenshot upload ----

  _queueScreenshotUpload(stepIndex, dataUrl) {
    this._uploadQueue.push({ stepIndex, dataUrl });
    this._processUploadQueue();
  }

  async _processUploadQueue() {
    if (this._uploading || this._uploadQueue.length === 0) return;
    this._uploading = true;

    while (this._uploadQueue.length > 0) {
      const { stepIndex, dataUrl } = this._uploadQueue.shift();
      try {
        const url = await this._uploadScreenshot(dataUrl);
        if (url) {
          // Update step with persistent URL
          const step = this.steps.find(s => s.index === stepIndex);
          if (step) step.screenshotUrl = url;
          this.screenshotUrls.set(stepIndex, url);
        }
      } catch (e) {
        console.warn('[SessionLogger] Screenshot upload failed for step', stepIndex, e.message);
      }
    }

    this._uploading = false;
  }

  async _uploadScreenshot(dataUrl) {
    // Convert data URL to Blob
    const match = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/);
    if (!match) return null;

    const mimeType = match[1];
    const base64Data = match[2];
    const binaryStr = atob(base64Data);
    const bytes = new Uint8Array(binaryStr.length);
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });

    const ext = mimeType === 'image/png' ? 'png' : 'jpg';
    const filename = `step_${Date.now()}.${ext}`;

    const formData = new FormData();
    formData.append('file', blob, filename);

    const r = await fetch(UPLOAD_URL, {
      method: 'POST',
      headers: {
        'X-Upload-Token': UPLOAD_TOKEN
      },
      body: formData
    });

    if (!r.ok) {
      throw new Error(`Upload failed: HTTP ${r.status}`);
    }

    const j = await r.json();
    return j.url || null;
  }

  /**
   * Wait for all pending screenshot uploads to complete.
   */
  async waitForUploads(timeoutMs = 60000) {
    const start = Date.now();
    while (this._uploading || this._uploadQueue.length > 0) {
      if (Date.now() - start > timeoutMs) break;
      await new Promise(r => setTimeout(r, 200));
    }
  }

  // ============================================================
  // HTML REPORT GENERATION
  // ============================================================

  /**
   * Generate a self-contained HTML report.
   * Screenshots are shown via persistent URLs (or inline base64 as fallback).
   */
  generateHtmlReport() {
    const duration = this.completedAt 
      ? (this.completedAt - this.startedAt) / 1000 
      : (Date.now() - this.startedAt.getTime()) / 1000;

    const totalSteps = this.steps.length;
    const apiCallsCount = this.apiCalls.length;
    const errorsCount = this.errors.length;

    let html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>WebClaw Session Report — ${this._esc(this.task.slice(0, 60))}</title>
  <style>
    :root { --bg: #0f1115; --surface: #1a1d24; --border: #2a2f3a; --text: #e6e8eb; --muted: #9aa3af; --green: #86efac; --red: #fca5a5; --blue: #93c5fd; --yellow: #facc15; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 22px; margin-bottom: 8px; display: flex; align-items: center; gap: 10px; }
    h1 .emoji { font-size: 28px; }
    .subtitle { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
    
    /* Summary cards */
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
    .card { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 16px; }
    .card .label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
    .card .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
    .card .value.ok { color: var(--green); }
    .card .value.err { color: var(--red); }

    /* Sections */
    .section { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 16px; overflow: hidden; }
    .section-header { padding: 12px 16px; background: #11141b; border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .section-header h2 { font-size: 14px; display: flex; align-items: center; gap: 8px; }
    .section-header .badge { font-size: 11px; background: #374151; padding: 2px 8px; border-radius: 10px; color: var(--muted); }
    .section-body { padding: 16px; }

    /* Steps timeline */
    .step { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
    .step-header { padding: 10px 14px; background: #11141b; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .step-header .step-num { font-weight: 600; color: var(--blue); }
    .step-header .step-time { font-size: 11px; color: var(--muted); }
    .step-header .step-action { font-size: 12px; color: var(--text); margin-left: 12px; flex: 1; }
    .step-body { padding: 14px; display: none; }
    .step-body.open { display: block; }
    
    .step-screenshot { margin-bottom: 12px; }
    .step-screenshot img { max-width: 100%; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; }
    .step-screenshot img:hover { border-color: var(--blue); }
    
    .step-detail { margin-bottom: 8px; }
    .step-detail .detail-label { font-size: 11px; color: var(--muted); text-transform: uppercase; margin-bottom: 4px; }
    .step-detail pre { background: #0b0d11; border: 1px solid var(--border); border-radius: 6px; padding: 10px; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd5e1; overflow-x: auto; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; }
    
    .action-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; }
    .action-badge.click { background: #1e3a5f; color: var(--blue); }
    .action-badge.type { background: #1e3a2f; color: var(--green); }
    .action-badge.scroll { background: #3a2f1e; color: var(--yellow); }
    .action-badge.navigate { background: #2f1e3a; color: #c4b5fd; }
    .action-badge.done { background: #1a3a1a; color: var(--green); }
    .action-badge.fail { background: #3a1a1a; color: var(--red); }
    .action-badge.other { background: #2a2f3a; color: var(--muted); }
    
    /* API calls */
    .api-call { border: 1px solid var(--border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; }
    .api-call-header { padding: 10px 14px; background: #11141b; display: flex; justify-content: space-between; align-items: center; cursor: pointer; }
    .api-call-header .status { font-weight: 600; }
    .api-call-header .status.ok { color: var(--green); }
    .api-call-header .status.err { color: var(--red); }
    .api-call-header .duration { font-size: 11px; color: var(--muted); }
    .api-call-body { padding: 14px; display: none; }
    .api-call-body.open { display: block; }
    
    .curl-block { background: #0b0d11; border: 1px solid #1f2330; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
    .curl-block .curl-label { font-size: 11px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; }
    .curl-block pre { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #86efac; white-space: pre-wrap; word-break: break-all; }
    
    .response-block { background: #0b0d11; border: 1px solid #1f2330; border-radius: 6px; padding: 12px; }
    .response-block .resp-label { font-size: 11px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; }
    .response-block pre { font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; color: #cbd5e1; white-space: pre-wrap; word-break: break-all; max-height: 400px; overflow-y: auto; }
    
    /* Errors section */
    .error-item { padding: 10px; border: 1px solid #3a1a1a; border-radius: 6px; margin-bottom: 8px; background: #1a0f0f; }
    .error-item .error-time { font-size: 11px; color: var(--muted); }
    .error-item .error-msg { color: var(--red); font-size: 13px; margin-top: 4px; }

    /* Footer */
    .footer { text-align: center; padding: 24px; color: var(--muted); font-size: 11px; }
    
    /* Lightbox */
    .lightbox { display: none; position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); z-index: 1000; cursor: pointer; justify-content: center; align-items: center; }
    .lightbox.active { display: flex; }
    .lightbox img { max-width: 95%; max-height: 95%; object-fit: contain; }

    /* Collapsible toggle */
    .toggle-icon { transition: transform 0.2s; font-size: 12px; }
    .toggle-icon.open { transform: rotate(90deg); }
  </style>
</head>
<body>
  <div class="container">
    <h1><span class="emoji">🦞</span> WebClaw Session Report</h1>
    <div class="subtitle">
      Task: ${this._esc(this.task)}<br>
      Started: ${this.startedAt.toLocaleString()} · Duration: ${duration.toFixed(1)}s · Model: ${this._esc(this.model)} · Provider: ${this._esc(this.provider)}
    </div>

    <!-- Summary Cards -->
    <div class="cards">
      <div class="card">
        <div class="label">Steps</div>
        <div class="value">${totalSteps}</div>
      </div>
      <div class="card">
        <div class="label">API Calls</div>
        <div class="value">${apiCallsCount}</div>
      </div>
      <div class="card">
        <div class="label">Screenshots</div>
        <div class="value">${this.screenshotUrls.size}</div>
      </div>
      <div class="card">
        <div class="label">Errors</div>
        <div class="value ${errorsCount > 0 ? 'err' : 'ok'}">${errorsCount}</div>
      </div>
      <div class="card">
        <div class="label">Tokens Used</div>
        <div class="value">${this.totalTokensUsed > 0 ? this.totalTokensUsed.toLocaleString() : '—'}</div>
      </div>
      <div class="card">
        <div class="label">Duration</div>
        <div class="value">${this._formatDuration(duration)}</div>
      </div>
    </div>

    <!-- Task Context -->
    ${this.context ? `
    <div class="section">
      <div class="section-header" onclick="toggleSection(this)">
        <h2>📋 Task Context</h2>
        <span class="toggle-icon">▶</span>
      </div>
      <div class="section-body">
        <pre>${this._esc(this.context)}</pre>
      </div>
    </div>` : ''}

    <!-- Steps Timeline -->
    <div class="section">
      <div class="section-header" onclick="toggleSection(this)">
        <h2>🎯 Steps Timeline</h2>
        <span class="badge">${totalSteps} steps</span>
      </div>
      <div class="section-body">
        ${this._generateStepsHtml()}
      </div>
    </div>

    <!-- API Calls Log -->
    <div class="section">
      <div class="section-header" onclick="toggleSection(this)">
        <h2>🔌 API Calls (CURL)</h2>
        <span class="badge">${apiCallsCount} calls</span>
      </div>
      <div class="section-body">
        ${this._generateApiCallsHtml()}
      </div>
    </div>

    <!-- Errors -->
    ${errorsCount > 0 ? `
    <div class="section">
      <div class="section-header" onclick="toggleSection(this)">
        <h2>❌ Errors</h2>
        <span class="badge">${errorsCount} errors</span>
      </div>
      <div class="section-body">
        ${this.errors.map(e => `
          <div class="error-item">
            <div class="error-time">${e.timestamp.toLocaleTimeString()}</div>
            <div class="error-msg">${this._esc(e.message)}</div>
          </div>
        `).join('')}
      </div>
    </div>` : ''}

    <div class="footer">
      Generated by WebClaw — AI Browser Agent · ${new Date().toLocaleString()}
    </div>
  </div>

  <!-- Lightbox for screenshots -->
  <div class="lightbox" id="lightbox" onclick="this.classList.remove('active')">
    <img id="lightbox-img" src="" alt="Screenshot">
  </div>

  <script>
    function toggleSection(header) {
      const body = header.nextElementSibling;
      const icon = header.querySelector('.toggle-icon');
      body.style.display = body.style.display === 'none' ? 'block' : (body.style.display === 'block' ? 'none' : 'block');
      if (icon) icon.classList.toggle('open');
    }
    
    function toggleStep(el) {
      const body = el.nextElementSibling;
      body.classList.toggle('open');
    }
    
    function toggleApiCall(el) {
      const body = el.nextElementSibling;
      body.classList.toggle('open');
    }
    
    function openLightbox(src) {
      document.getElementById('lightbox-img').src = src;
      document.getElementById('lightbox').classList.add('active');
    }
    
    // Auto-expand first 3 steps
    document.querySelectorAll('.step-body').forEach((el, i) => { if (i < 3) el.classList.add('open'); });
    // Auto-expand first API call
    document.querySelectorAll('.api-call-body').forEach((el, i) => { if (i < 1) el.classList.add('open'); });
  </script>
</body>
</html>`;

    return html;
  }

  _generateStepsHtml() {
    if (this.steps.length === 0) return '<p style="color: var(--muted);">No steps recorded.</p>';

    return this.steps.map(step => {
      const actionType = step.parsedAction?.action || 'unknown';
      const actionClass = ['click', 'type', 'scroll', 'navigate', 'done', 'fail'].includes(actionType) ? actionType : 'other';
      const screenshotSrc = step.screenshotUrl || step.screenshotDataUrl || '';
      const hasScreenshot = !!screenshotSrc;
      const time = step.timestamp.toLocaleTimeString();

      return `
      <div class="step">
        <div class="step-header" onclick="toggleStep(this)">
          <span class="step-num">#${step.index}</span>
          <span class="step-action">
            <span class="action-badge ${actionClass}">${this._esc(actionType)}</span>
            ${step.parsedAction?.reason ? ` — ${this._esc(step.parsedAction.reason.slice(0, 100))}` : ''}
          </span>
          <span class="step-time">${time}</span>
        </div>
        <div class="step-body">
          ${hasScreenshot ? `
          <div class="step-screenshot">
            <img src="${this._esc(screenshotSrc)}" alt="Step ${step.index} screenshot" onclick="openLightbox('${this._esc(screenshotSrc)}')" loading="lazy" />
          </div>` : ''}
          
          ${step.pageInfo?.url ? `
          <div class="step-detail">
            <div class="detail-label">Page URL</div>
            <pre>${this._esc(step.pageInfo.url)}</pre>
          </div>` : ''}
          
          ${step.parsedAction ? `
          <div class="step-detail">
            <div class="detail-label">Action (parsed)</div>
            <pre>${this._esc(JSON.stringify(step.parsedAction, null, 2))}</pre>
          </div>` : ''}
          
          ${step.modelResponse ? `
          <div class="step-detail">
            <div class="detail-label">Model Response (raw)</div>
            <pre>${this._esc(step.modelResponse.slice(0, 2000))}</pre>
          </div>` : ''}

          ${step.observation ? `
          <div class="step-detail">
            <div class="detail-label">Observation</div>
            <pre>${this._esc(JSON.stringify(step.observation, null, 2).slice(0, 1000))}</pre>
          </div>` : ''}

          ${step.error ? `
          <div class="step-detail">
            <div class="detail-label">Error</div>
            <pre style="color: var(--red);">${this._esc(step.error)}</pre>
          </div>` : ''}
        </div>
      </div>`;
    }).join('\n');
  }

  _generateApiCallsHtml() {
    if (this.apiCalls.length === 0) return '<p style="color: var(--muted);">No API calls recorded.</p>';

    return this.apiCalls.map((call, i) => {
      const time = call.timestamp.toLocaleTimeString();
      const statusClass = call.error ? 'err' : 'ok';
      const statusText = call.error ? `ERROR: ${call.error}` : `HTTP ${call.responseStatus || '200'}`;
      const durationText = call.durationMs ? `${call.durationMs}ms` : '';

      // Format response body (truncate if needed)
      let responseDisplay = '';
      if (call.responseBody) {
        const respStr = typeof call.responseBody === 'string' 
          ? call.responseBody 
          : JSON.stringify(call.responseBody, null, 2);
        responseDisplay = respStr.length > 5000 ? respStr.slice(0, 5000) + `\n... [truncated]` : respStr;
      }

      // Format request body (truncate, mask images)
      let requestDisplay = '';
      if (call.requestBody) {
        let bodyStr = typeof call.requestBody === 'string'
          ? call.requestBody
          : JSON.stringify(call.requestBody, null, 2);
        // Mask base64 image data for readability
        bodyStr = bodyStr.replace(/"data:image\/[^"]+;base64,[A-Za-z0-9+/=]{50,}"/g, '"[BASE64_IMAGE: see screenshots section]"');
        requestDisplay = bodyStr.length > 8000 ? bodyStr.slice(0, 8000) + `\n... [truncated]` : bodyStr;
      }

      return `
      <div class="api-call">
        <div class="api-call-header" onclick="toggleApiCall(this)">
          <span>
            <span class="status ${statusClass}">${statusText}</span>
            <span style="margin-left: 8px; font-size: 12px; color: var(--muted);">${this._esc(call.provider || '')} · ${this._esc(call.url || '').slice(0, 60)}</span>
          </span>
          <span class="duration">${time}${durationText ? ' · ' + durationText : ''}</span>
        </div>
        <div class="api-call-body">
          <div class="curl-block">
            <div class="curl-label">📡 CURL Command</div>
            <pre>${this._esc(call.curl)}</pre>
          </div>
          ${requestDisplay ? `
          <div class="step-detail">
            <div class="detail-label">Request Body</div>
            <pre>${this._esc(requestDisplay)}</pre>
          </div>` : ''}
          ${responseDisplay ? `
          <div class="response-block">
            <div class="resp-label">📨 Raw Response</div>
            <pre>${this._esc(responseDisplay)}</pre>
          </div>` : ''}
        </div>
      </div>`;
    }).join('\n');
  }

  // ---- API Log file generation (raw CURL + responses) ----

  /**
   * Generate a plain-text API log with CURL commands and raw responses.
   * Can be saved as a .txt or .log file for debugging.
   */
  generateApiLogText() {
    const lines = [];
    lines.push('=' .repeat(80));
    lines.push('WebClaw API Log');
    lines.push(`Session: ${this.sessionId}`);
    lines.push(`Task: ${this.task}`);
    lines.push(`Model: ${this.model}`);
    lines.push(`Provider: ${this.provider}`);
    lines.push(`Started: ${this.startedAt.toISOString()}`);
    lines.push('=' .repeat(80));
    lines.push('');

    for (const call of this.apiCalls) {
      lines.push('-'.repeat(80));
      lines.push(`[${call.timestamp.toISOString()}] ${call.provider || ''} ${call.method || 'POST'} ${call.url || ''}`);
      lines.push(`Status: ${call.error ? 'ERROR: ' + call.error : 'HTTP ' + (call.responseStatus || '200')}`);
      if (call.durationMs) lines.push(`Duration: ${call.durationMs}ms`);
      lines.push('');
      lines.push('CURL:');
      lines.push(call.curl);
      lines.push('');
      
      if (call.requestBody) {
        lines.push('REQUEST BODY:');
        let bodyStr = typeof call.requestBody === 'string' ? call.requestBody : JSON.stringify(call.requestBody, null, 2);
        // Mask base64 images
        bodyStr = bodyStr.replace(/"data:image\/[^"]+;base64,[A-Za-z0-9+/=]{50,}"/g, '"[BASE64_IMAGE]"');
        lines.push(bodyStr.slice(0, 10000));
        lines.push('');
      }

      if (call.responseBody) {
        lines.push('RAW RESPONSE:');
        const respStr = typeof call.responseBody === 'string' ? call.responseBody : JSON.stringify(call.responseBody, null, 2);
        lines.push(respStr.slice(0, 10000));
        lines.push('');
      }

      lines.push('');
    }

    lines.push('=' .repeat(80));
    lines.push(`Total API calls: ${this.apiCalls.length}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push('=' .repeat(80));

    return lines.join('\n');
  }

  // ---- Download helpers ----

  /**
   * Download the HTML report as a file.
   * Uses chrome.downloads API (works in service worker context).
   */
  downloadHtmlReport() {
    const html = this.generateHtmlReport();
    const dataUrl = 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
    chrome.downloads.download({
      url: dataUrl,
      filename: `webclaw-report-${this._dateSlug()}.html`,
      saveAs: false
    });
  }

  /**
   * Download the API log as a text file.
   * Uses chrome.downloads API (works in service worker context).
   */
  downloadApiLog() {
    const text = this.generateApiLogText();
    const dataUrl = 'data:text/plain;charset=utf-8,' + encodeURIComponent(text);
    chrome.downloads.download({
      url: dataUrl,
      filename: `webclaw-api-log-${this._dateSlug()}.txt`,
      saveAs: false
    });
  }

  // ---- Utilities ----

  _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  _formatDuration(seconds) {
    if (seconds < 60) return `${seconds.toFixed(0)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  }

  _dateSlug() {
    return new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
  }
}

/* ============================================================
   AI PROMPT TESTER — Frontend Logic
   ============================================================ */

// ---- Auth Check ----
(async function() {
  const token = sessionStorage.getItem('wa_token');
  if (!token) { window.location.href = '/login.html'; return; }
  try {
    const r = await fetch('/api/auth/check?token=' + encodeURIComponent(token));
    const d = await r.json();
    if (!d.valid) { sessionStorage.removeItem('wa_token'); window.location.href = '/login.html'; }
  } catch { window.location.href = '/login.html'; }
})();

// ---- State ----
let currentProvider = 'gemini';
let imageBase64 = null;
let imageMimeType = null;
let sessionHistory = [];
let lastRawResponse = null;
let lastRequestPayload = null;

// ---- Persistence (server-side ai-config.json) ----
let saveDebounceTimer = null;

function setSaveStatus(state, text) {
  const el = document.getElementById('save-status');
  el.className = 'save-status ' + state;
  el.textContent = text;
  if (state === 'saved' || state === 'error') {
    setTimeout(() => { el.className = 'save-status'; el.textContent = ''; }, 3000);
  }
}

async function saveConfigToServer() {
  setSaveStatus('saving', '↑ Saving…');
  try {
    const cfg = {
      provider:      currentProvider,
      model:         modelInput.value.trim(),
      geminiKey:     geminiKeyInput.value.trim(),
      openrouterKey: openrouterKeyInput.value.trim(),
      systemPrompt:  systemPromptInput.value
    };
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg)
    });
    if (res.ok) {
      setSaveStatus('saved', '✓ Saved');
      // Also mirror to localStorage as offline fallback
      localStorage.setItem('ai_tester_config', JSON.stringify(cfg));
    } else {
      setSaveStatus('error', '✗ Failed');
    }
  } catch (e) {
    setSaveStatus('error', '✗ Offline');
  }
}

function scheduleAutoSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(saveConfigToServer, 1200);
}

async function loadConfigFromServer() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('not ok');
    const { config: cfg } = await res.json();
    applyConfig(cfg);
    return;
  } catch (e) { /* fall through to localStorage */ }
  // Fallback: localStorage
  try {
    const raw = localStorage.getItem('ai_tester_config');
    if (raw) applyConfig(JSON.parse(raw));
  } catch (e) { /* ignore */ }
}

function applyConfig(cfg) {
  if (!cfg) return;
  if (cfg.provider) {
    currentProvider = cfg.provider;
    tabGemini.classList.toggle('active', currentProvider === 'gemini');
    tabOpenRouter.classList.toggle('active', currentProvider === 'openrouter');
    updateModelHint();
  }
  if (cfg.model)         modelInput.value         = cfg.model;
  if (cfg.geminiKey)     geminiKeyInput.value     = cfg.geminiKey;
  if (cfg.openrouterKey) openrouterKeyInput.value = cfg.openrouterKey;
  if (cfg.systemPrompt !== undefined) systemPromptInput.value = cfg.systemPrompt;
}

// ---- DOM Refs ----
const tabGemini = document.getElementById('tab-gemini');
const tabOpenRouter = document.getElementById('tab-openrouter');
const modelInput = document.getElementById('model-input');
const modelHint = document.getElementById('model-hint');
const geminiKeyInput = document.getElementById('gemini-key-input');
const openrouterKeyInput = document.getElementById('openrouter-key-input');
const saveConfigBtn = document.getElementById('save-config-btn');
const systemPromptInput = document.getElementById('system-prompt-input');
const userMessageInput = document.getElementById('user-message-input');
const imageUploadZone = document.getElementById('image-upload-zone');
const imageFileInput = document.getElementById('image-file-input');
const imagePreviewThumb = document.getElementById('image-preview-thumb');
const imageClearBtn = document.getElementById('image-clear-btn');
const imageInfoLabel = document.getElementById('image-info-label');
const runBtn = document.getElementById('run-btn');

const chipProvider = document.getElementById('chip-provider');
const chipProviderText = document.getElementById('chip-provider-text');
const chipModel = document.getElementById('chip-model');
const chipModelText = document.getElementById('chip-model-text');
const chipElapsed = document.getElementById('chip-elapsed');
const chipElapsedText = document.getElementById('chip-elapsed-text');
const btnCopyResponse = document.getElementById('btn-copy-response');

const outTabBtns = document.querySelectorAll('.out-tab-btn');
const outPanes = document.querySelectorAll('.out-pane');

const idleState = document.getElementById('idle-state');
const loadingState = document.getElementById('loading-state');
const loadingProviderLabel = document.getElementById('loading-provider-label');
const errorCard = document.getElementById('error-card');
const errorTitle = document.getElementById('error-title');
const errorMessage = document.getElementById('error-message');
const errorRawToggle = document.getElementById('error-raw-toggle');
const errorRawPre = document.getElementById('error-raw-pre');
const responseBubble = document.getElementById('response-bubble');
const responseProviderLabel = document.getElementById('response-provider-label');
const responseTimeLabel = document.getElementById('response-time-label');
const responseTextContent = document.getElementById('response-text-content');

const rawJsonContent = document.getElementById('raw-json-content');
const requestDebugContent = document.getElementById('request-debug-content');
const historyList = document.getElementById('history-list');

const sysPromptChars = document.getElementById('sys-prompt-chars');
const userMsgChars = document.getElementById('user-msg-chars');

// ---- Init ----
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  bindProviderTabs();
  bindOutputTabs();
  bindImageUpload();
  bindRunButton();
  bindCopyButtons();

  // Load config from server (fallback to localStorage)
  await loadConfigFromServer();
  updateCharCounts();

  // Load persisted AI test history
  await loadHistory();

  // Auto-save with debounce on any config field change
  modelInput.addEventListener('input', scheduleAutoSave);
  geminiKeyInput.addEventListener('input', scheduleAutoSave);
  openrouterKeyInput.addEventListener('input', scheduleAutoSave);
  systemPromptInput.addEventListener('input', () => { updateCharCounts(); scheduleAutoSave(); });
  userMessageInput.addEventListener('input', updateCharCounts);

  // Manual save button
  saveConfigBtn.addEventListener('click', saveConfigToServer);
});

// ---- Provider Tabs ----
function updateModelHint() {
  if (currentProvider === 'gemini') {
    modelHint.textContent = 'Default Gemini model. Try: gemini-1.5-pro, gemini-2.0-flash-lite, gemini-3.1-flash-lite-preview';
  } else {
    modelHint.textContent = 'OpenRouter model ID. Try: google/gemini-2.0-flash-lite-001, openai/gpt-4o-mini, anthropic/claude-haiku';
  }
}

function bindProviderTabs() {
  [tabGemini, tabOpenRouter].forEach(tab => {
    tab.addEventListener('click', () => {
      currentProvider = tab.dataset.provider;
      tabGemini.classList.toggle('active', currentProvider === 'gemini');
      tabOpenRouter.classList.toggle('active', currentProvider === 'openrouter');

      // Only set default model if user hasn't customized it
      if (currentProvider === 'gemini' && modelInput.value.startsWith('google/')) {
        modelInput.value = 'gemini-2.0-flash-lite';
      } else if (currentProvider === 'openrouter' && !modelInput.value.includes('/')) {
        modelInput.value = 'google/gemini-2.0-flash-lite-001';
      }
      updateModelHint();
      scheduleAutoSave();
    });
  });
}

// ---- Output Tabs ----
function bindOutputTabs() {
  outTabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const paneId = 'pane-' + btn.dataset.pane;
      outTabBtns.forEach(b => b.classList.remove('active'));
      outPanes.forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(paneId).classList.add('active');
    });
  });
}

// ---- Image Upload ----
function bindImageUpload() {
  imageUploadZone.addEventListener('click', (e) => {
    if (e.target === imageClearBtn || imageClearBtn.contains(e.target)) return;
    imageFileInput.click();
  });

  imageFileInput.addEventListener('change', () => {
    if (imageFileInput.files[0]) loadImageFile(imageFileInput.files[0]);
  });

  imageUploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    imageUploadZone.classList.add('dragging');
  });
  imageUploadZone.addEventListener('dragleave', () => imageUploadZone.classList.remove('dragging'));
  imageUploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    imageUploadZone.classList.remove('dragging');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadImageFile(file);
  });

  imageClearBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    clearImage();
  });
}

function loadImageFile(file) {
  if (file.size > 10 * 1024 * 1024) {
    alert('Image too large. Max 10MB allowed.');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    const base64 = dataUrl.split(',')[1];
    imageBase64 = base64;
    imageMimeType = file.type;
    imagePreviewThumb.src = dataUrl;
    imageUploadZone.classList.add('has-image');
    imageInfoLabel.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB, ${file.type})`;
    lucide.createIcons();
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  imageBase64 = null;
  imageMimeType = null;
  imagePreviewThumb.src = '';
  imageFileInput.value = '';
  imageUploadZone.classList.remove('has-image');
  imageInfoLabel.textContent = '';
}

// ---- Char Counts ----
function updateCharCounts() {
  sysPromptChars.textContent = systemPromptInput.value.length + ' chars';
  userMsgChars.textContent = userMessageInput.value.length + ' chars';
}

// ---- Run Button ----
function bindRunButton() {
  runBtn.addEventListener('click', runAITest);
}

async function runAITest() {
  const provider = currentProvider;
  const model = modelInput.value.trim();
  const systemPrompt = systemPromptInput.value.trim();
  const userMessage = userMessageInput.value.trim();

  // Pick the right key for the active provider
  const apiKey = provider === 'openrouter'
    ? openrouterKeyInput.value.trim()
    : geminiKeyInput.value.trim();

  // Validation
  if (!apiKey) {
    const keyLabel = provider === 'openrouter' ? 'OpenRouter' : 'Gemini';
    showError('API Key Required', `Please enter your ${keyLabel} API key in the config panel.`);
    return;
  }
  if (!userMessage && !imageBase64) { showError('Input Required', 'Please type a message or attach an image.'); return; }

  // Build request payload (log for debug pane, but strip base64 for display)
  const payload = { provider, model: model || undefined, apiKey, systemPrompt: systemPrompt || undefined, userMessage: userMessage || undefined, imageBase64: imageBase64 || undefined, imageMimeType: imageMimeType || undefined };
  lastRequestPayload = payload;

  // Set loading UI
  setLoadingState(true, provider);

  try {
    const res = await fetch('/api/ai-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    lastRawResponse = data;

    const rawJson = JSON.stringify(data, null, 2);

    if (!res.ok || !data.success) {
      showError(
        `API Error (${res.status})`,
        data.error || 'Unknown error from AI provider.',
        data.raw ? JSON.stringify(data.raw, null, 2) : null
      );
      addToHistory(provider, model, { responseText: '[Error] ' + (data.error || 'Unknown'), elapsedMs: data.elapsedMs || 0 }, payload, rawJson);
    } else {
      showResponse(data);
      addToHistory(provider, model, data, payload, rawJson);
    }

    rawJsonContent.textContent = rawJson;
    updateRequestDebugPane(payload, res.status, data.elapsedMs);

  } catch (err) {
    showError('Network Error', err.message);
    addToHistory(provider, model, { responseText: '[Network Error] ' + err.message, elapsedMs: 0 }, null, null);
  } finally {
    setLoadingState(false);
  }
}

// ---- UI State Helpers ----
function setLoadingState(loading, provider = '') {
  runBtn.disabled = loading;
  runBtn.classList.toggle('loading', loading);

  if (loading) {
    loadingProviderLabel.textContent = provider === 'gemini' ? 'Gemini' : 'OpenRouter';
    idleState.style.display = 'none';
    loadingState.classList.add('visible');
    errorCard.classList.remove('visible');
    responseBubble.classList.remove('visible');
  } else {
    loadingState.classList.remove('visible');
  }
}

function showError(title, message, rawText = null) {
  idleState.style.display = 'none';
  errorCard.classList.add('visible');
  responseBubble.classList.remove('visible');
  errorTitle.textContent = title;
  errorMessage.textContent = message;
  errorRawPre.classList.remove('visible');
  errorRawPre.textContent = rawText || '';
  errorRawToggle.style.display = rawText ? 'block' : 'none';

  // Switch to response pane
  switchToPane('response');
}

function showResponse(data) {
  idleState.style.display = 'none';
  errorCard.classList.remove('visible');
  responseBubble.classList.add('visible');

  responseProviderLabel.textContent = data.provider === 'gemini' ? '✦ Gemini' : '◈ OpenRouter';
  responseTimeLabel.textContent = `${data.model} · ${data.elapsedMs}ms · ${new Date().toLocaleTimeString()}`;
  responseTextContent.textContent = data.responseText;

  // Update meta chips
  chipProvider.classList.remove('hidden');
  chipProviderText.textContent = data.provider === 'gemini' ? 'Gemini' : 'OpenRouter';
  chipModel.classList.remove('hidden');
  chipModelText.textContent = data.model;
  chipElapsed.classList.remove('hidden');
  chipElapsedText.textContent = data.elapsedMs + 'ms';
  btnCopyResponse.classList.remove('hidden');

  switchToPane('response');
  lucide.createIcons();
}

function updateRequestDebugPane(payload, statusCode, elapsed) {
  const endpoint = '/api/ai-test';
  const displayPayload = {
    provider: payload.provider,
    model: payload.model,
    systemPrompt: payload.systemPrompt ? payload.systemPrompt.substring(0, 80) + '...' : undefined,
    userMessage: payload.userMessage,
    imageBase64: payload.imageBase64 ? `[base64 image, ${Math.round(payload.imageBase64.length * 0.75 / 1024)}KB]` : undefined,
    imageMimeType: payload.imageMimeType
  };

  requestDebugContent.innerHTML = `
    <div class="req-block">
      <div class="req-section">
        <div class="req-section-title">HTTP Request</div>
        <div class="req-row">
          <span class="req-label">Method</span>
          <span class="req-value"><span class="http-verb">POST</span><span class="req-endpoint">${endpoint}</span></span>
        </div>
        <div class="req-row">
          <span class="req-label">Status</span>
          <span class="req-value highlight">${statusCode}</span>
        </div>
        <div class="req-row">
          <span class="req-label">Elapsed</span>
          <span class="req-value highlight">${elapsed}ms</span>
        </div>
        <div class="req-row">
          <span class="req-label">Provider</span>
          <span class="req-value">${payload.provider}</span>
        </div>
        <div class="req-row">
          <span class="req-label">Model</span>
          <span class="req-value">${payload.model || '(default)'}</span>
        </div>
      </div>
      <div class="req-section">
        <div class="req-section-title">Request Body (sanitized)</div>
        <pre class="debug-json-block" style="margin:0;">${JSON.stringify(displayPayload, null, 2)}</pre>
      </div>
    </div>
  `;
  lucide.createIcons();
}

async function loadHistory() {
  try {
    const res = await fetch('/api/ai-history');
    const data = await res.json();
    if (data.success && data.history) {
      sessionHistory = data.history;
      renderHistory();
    }
  } catch { /* silent */ }
}

async function addToHistory(provider, model, data, requestPayload, rawResponse) {
  const entry = {
    provider,
    model: model || '(default)',
    responseText: data.responseText,
    elapsedMs: data.elapsedMs || 0,
    requestPayload: requestPayload ? sanitizePayload(requestPayload) : null,
    rawResponse: rawResponse || null,
    time: new Date().toISOString()
  };
  // Save to server
  try {
    await fetch('/api/ai-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entry })
    });
  } catch { /* silent */ }
  sessionHistory.unshift(entry);
  renderHistory();
}

function sanitizePayload(payload) {
  const p = { ...payload };
  if (p.apiKey) p.apiKey = p.apiKey.substring(0, 6) + '...';
  if (p.imageBase64) p.imageBase64 = `[base64 image, ${Math.round(p.imageBase64.length * 0.75 / 1024)}KB]`;
  return p;
}

function renderHistory() {
  if (sessionHistory.length === 0) {
    historyList.innerHTML = '<div class="history-empty">No requests in this session yet.</div>';
    return;
  }
  historyList.innerHTML = `<div class="history-actions"><button class="history-clear-all hidden" id="btn-clear-history"><i data-lucide="trash-2"></i> Clear All</button></div>` + sessionHistory.map((entry, i) => `
    <div class="history-item" data-index="${i}">
      <div class="history-item-top">
        <span class="history-provider ${entry.provider === 'gemini' ? 'provider-gem' : 'provider-or'}">
          ${entry.provider === 'gemini' ? '⚡ Gemini' : '◈ OpenRouter'}
        </span>
        <span class="history-time">${new Date(entry.time).toLocaleTimeString()}</span>
        <button class="history-del-btn" data-time="${entry.time}" title="Delete entry"><i data-lucide="x"></i></button>
      </div>
      <div class="history-model">${entry.model}</div>
      <div class="history-preview">${entry.responseText}</div>
      <div class="history-elapsed">${entry.elapsedMs}ms</div>
    </div>
  `).join('');

  // Bind delete buttons
  historyList.querySelectorAll('.history-del-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const time = btn.dataset.time;
      try {
        await fetch('/api/ai-history/' + encodeURIComponent(time), { method: 'DELETE' });
        sessionHistory = sessionHistory.filter(e => e.time !== time);
        renderHistory();
      } catch { /* silent */ }
    });
  });

  // Bind clear all
  const clearBtn = document.getElementById('btn-clear-history');
  if (sessionHistory.length > 0) {
    clearBtn.classList.remove('hidden');
    clearBtn.addEventListener('click', async () => {
      try {
        await fetch('/api/ai-history', { method: 'DELETE' });
        sessionHistory = [];
        renderHistory();
      } catch { /* silent */ }
    });
  }

  lucide.createIcons();

  historyList.querySelectorAll('.history-item').forEach(item => {
    item.addEventListener('click', () => {
      const idx = parseInt(item.dataset.index);
      const entry = sessionHistory[idx];
      // Restore to response pane
      responseProviderLabel.textContent = entry.provider === 'gemini' ? '✦ Gemini' : '◈ OpenRouter';
      responseTimeLabel.textContent = `${entry.model} · ${entry.elapsedMs}ms · ${new Date(entry.time).toLocaleTimeString()}`;
      responseTextContent.textContent = entry.responseText;
      idleState.style.display = 'none';
      errorCard.classList.remove('visible');
      responseBubble.classList.add('visible');

      // Restore raw JSON
      rawJsonContent.textContent = entry.rawResponse || '// No raw response saved';

      // Restore request debug pane
      if (entry.requestPayload) {
        requestDebugContent.innerHTML = `
          <div class="req-block">
            <div class="req-section">
              <div class="req-section-title">HTTP Request</div>
              <div class="req-row">
                <span class="req-label">Method</span>
                <span class="req-value"><span class="http-verb">POST</span><span class="req-endpoint">/api/ai-test</span></span>
              </div>
              <div class="req-row">
                <span class="req-label">Elapsed</span>
                <span class="req-value highlight">${entry.elapsedMs}ms</span>
              </div>
              <div class="req-row">
                <span class="req-label">Provider</span>
                <span class="req-value">${entry.provider}</span>
              </div>
              <div class="req-row">
                <span class="req-label">Model</span>
                <span class="req-value">${entry.model}</span>
              </div>
            </div>
            <div class="req-section">
              <div class="req-section-title">Request Body (sanitized)</div>
              <pre class="debug-json-block" style="margin:0;">${JSON.stringify(entry.requestPayload, null, 2)}</pre>
            </div>
          </div>
        `;
      } else {
        requestDebugContent.innerHTML = '<p style="color:var(--text-muted);font-size:0.8rem;">No request data saved.</p>';
      }

      switchToPane('response');
    });
  });
}

function switchToPane(paneName) {
  outTabBtns.forEach(b => b.classList.toggle('active', b.dataset.pane === paneName));
  outPanes.forEach(p => p.classList.toggle('active', p.id === 'pane-' + paneName));
}

// ---- Copy Buttons ----
function bindCopyButtons() {
  btnCopyResponse.addEventListener('click', () => {
    copyText(responseTextContent.textContent, btnCopyResponse);
  });

  errorRawToggle.addEventListener('click', () => {
    errorRawPre.classList.toggle('visible');
    errorRawToggle.textContent = errorRawPre.classList.contains('visible') ? 'Hide raw response' : 'Show raw response';
  });
}

function copyText(text, btn) {
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied!';
    setTimeout(() => { btn.innerHTML = orig; lucide.createIcons(); }, 2000);
  });
}

'use strict';

// ── Defaults / config ────────────────────────────────────────────
const CFG_KEY = 'livetranscribe_settings';

function loadCfg() {
  try { return { ...defaultCfg(), ...JSON.parse(localStorage.getItem(CFG_KEY) || '{}') }; }
  catch { return defaultCfg(); }
}
function saveCfg(c) { localStorage.setItem(CFG_KEY, JSON.stringify(c)); }
function defaultCfg() {
  return {
    endpoint:           'http://localhost:5000',
    model:              'base',
    chunkInterval:      3,
    splitWords:         8,
    language:           '',
    translationEnabled: false,
    ollamaUrl:          'http://localhost:11434',
    ollamaModel:        'llama3',
    targetLang:         'English',
  };
}

let cfg = loadCfg();

// ── DOM refs ─────────────────────────────────────────────────────
const logo          = document.getElementById('logo');
const serverBadge   = document.getElementById('server-badge');
const toggleBtn     = document.getElementById('toggle-btn');
const micPill       = document.getElementById('mic-pill');
const timerEl       = document.getElementById('timer-el');
const youBody       = document.getElementById('you-body');
const youInterim             = document.getElementById('you-interim');
const youInterimTranslation  = document.getElementById('you-interim-translation');
const clearBtn      = document.getElementById('clear-btn');
const copyBtn       = document.getElementById('copy-btn');
const settingsBtn   = document.getElementById('settings-btn');
const overlay       = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');

// Settings inputs
const sEndpoint        = document.getElementById('s-endpoint');
const sModel           = document.getElementById('s-model');
const sChunk           = document.getElementById('s-chunk');
const sChunkLabel      = document.getElementById('s-chunk-label');
const sSplitWords      = document.getElementById('s-split-words');
const sSplitWordsLabel = document.getElementById('s-split-words-label');
const sLanguage        = document.getElementById('s-language');
const sTest            = document.getElementById('s-test');
const sTestResult      = document.getElementById('s-test-result');
const sSave            = document.getElementById('s-save');
const sSaved           = document.getElementById('s-saved');

// Translation settings inputs
const sTranslationEnabled = document.getElementById('s-translation-enabled');
const sOllamaUrl          = document.getElementById('s-ollama-url');
const sOllamaModel        = document.getElementById('s-ollama-model');
const sTargetLang         = document.getElementById('s-target-lang');
const sOllamaTest         = document.getElementById('s-ollama-test');
const sOllamaTestResult   = document.getElementById('s-ollama-test-result');
const ollamaBadge         = document.getElementById('ollama-badge');

// ── State ────────────────────────────────────────────────────────
let isRecording   = false;
let sessionStart  = null;
let timerInterval = null;

let micStream    = null;
let micRecorder  = null;
let micTimer     = null;
let micAudioCtx  = null;

const youSegs = [];   // { id, text, translation, ts }

// ── Server health check ──────────────────────────────────────────
async function checkServer() {
  try {
    const res = await fetch(`${cfg.endpoint}/health`, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const d = await res.json();
      setBadge('online', `● Server online (${d.model})`);
      return true;
    }
    setBadge('error', '● Server error');
    return false;
  } catch {
    setBadge('offline', '● Server offline');
    return false;
  }
}
function setBadge(state, text) {
  serverBadge.className = `badge ${state}`;
  serverBadge.textContent = text;
}
checkServer();
setInterval(checkServer, 8000);

// ── Ollama health check ──────────────────────────────────────────
async function checkOllama() {
  if (!cfg.translationEnabled) {
    setOllamaBadge('offline', '● Ollama offline');
    return false;
  }
  try {
    const res = await fetch(`${cfg.endpoint}/ollama/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const d = await res.json();
      setOllamaBadge('online', `● Ollama (${d.active_model})`);
      return true;
    }
    setOllamaBadge('error', '● Ollama error');
    return false;
  } catch {
    setOllamaBadge('offline', '● Ollama offline');
    return false;
  }
}
function setOllamaBadge(state, text) {
  ollamaBadge.className = `badge ${state}`;
  ollamaBadge.textContent = text;
}
checkOllama();
setInterval(checkOllama, 8000);

// ── Timer ────────────────────────────────────────────────────────
function startTimer() {
  sessionStart = Date.now();
  timerInterval = setInterval(() => {
    const ms = Date.now() - sessionStart;
    const s  = Math.floor(ms / 1000);
    const m  = Math.floor(s / 60);
    const h  = Math.floor(m / 60);
    const p  = n => String(n).padStart(2, '0');
    timerEl.textContent = h ? `${h}:${p(m % 60)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
  timerEl.textContent = '';
}

// ── Segment rendering ────────────────────────────────────────────
function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Split on sentence punctuation and commas only.
// Word-count splitting is handled server-side via max_words.
function splitSentences(text) {
  const parts = text
    .split(/(?<=[.!?。？！])\s+/)
    .flatMap(chunk => {
      chunk = chunk.trim();
      if (!chunk) return [];
      return chunk.split(/(?<=[,;])\s+/).map(s => s.trim()).filter(Boolean);
    })
    .filter(Boolean);
  return parts.length ? parts : [text];
}

function addSegment(text) {
  const seg = { id: Date.now() + Math.random(), text, translation: '', ts: Date.now() };
  youSegs.push(seg);
  youBody.querySelector('.empty-hint')?.remove();

  const t  = new Date(seg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const el = document.createElement('div');
  el.className = 'seg';
  el.innerHTML = `<span class="seg-text">${esc(text)}</span>`
    + `<span class="seg-translation"></span>`
    + `<span class="seg-time">${t}</span>`;
  youBody.appendChild(el);
  youBody.scrollTop = youBody.scrollHeight;
  return { el, seg };
}

function addSegments(text) {
  splitSentences(text).forEach(sentence => {
    const { el, seg } = addSegment(sentence);
    if (cfg.translationEnabled) translateSegment(sentence, el, seg);
  });
}

// ── Translation (Ollama — final segments) ────────────────────────
async function translateSegment(text, segEl, seg) {
  if (!cfg.translationEnabled || !text) return;
  const translEl = segEl.querySelector('.seg-translation');
  if (!translEl) return;

  translEl.textContent = '';
  translEl.classList.add('loading');
  translEl.classList.remove('error');

  try {
    const res = await fetch(`${cfg.endpoint}/v1/translate/stream`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ text, target_lang: cfg.targetLang, model: cfg.ollamaModel, ollama_url: cfg.ollamaUrl }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      translEl.textContent = `⚠ ${err.detail || res.status}`;
      translEl.classList.add('error');
      translEl.classList.remove('loading');
      return;
    }
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let translation = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      translation += decoder.decode(value, { stream: true });
      translEl.textContent = translation;
      const col = segEl.closest('.col-body');
      if (col) col.scrollTop = col.scrollHeight;
    }
    if (seg) seg.translation = translation.trim();
  } catch (err) {
    translEl.textContent = `⚠ ${err.message}`;
    translEl.classList.add('error');
  }
  translEl.classList.remove('loading');
}

// ── Interim translation (Google Translate — fast, live) ──────────
let _interimDebounce  = null;
let _interimAbort     = null;
let _lastInterimWords = 0;

function translateInterim(text) {
  if (!cfg.translationEnabled || !text) return;

  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount <= _lastInterimWords) return;

  clearTimeout(_interimDebounce);
  _interimDebounce = setTimeout(async () => {
    if (_interimAbort) _interimAbort.abort();
    _interimAbort = new AbortController();
    _lastInterimWords = wordCount;

    try {
      const res = await fetch(`${cfg.endpoint}/v1/translate/realtime`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, target_lang: cfg.targetLang }),
        signal:  _interimAbort.signal,
      });
      if (!res.ok) { youInterimTranslation.textContent = ''; return; }
      const { translation } = await res.json();
      if (translation) youInterimTranslation.textContent = translation;
    } catch (e) {
      if (e.name !== 'AbortError') youInterimTranslation.textContent = '';
    }
  }, 80);
}

// ── Mic pipeline — getUserMedia → Whisper ────────────────────────
async function startMic() {
  setPill(micPill, 'idle', 'Mic: requesting...');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    const msg = err.name === 'NotAllowedError'  ? 'Mic: permission denied' :
                err.name === 'NotFoundError'    ? 'Mic: not found' :
                err.name === 'NotReadableError' ? 'Mic: in use by another app' :
                                                  `Mic: ${err.name}`;
    setPill(micPill, 'error', msg);
    return;
  }

  setPill(micPill, 'active', 'Mic: listening');

  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';

  const SILENCE_THRESHOLD = 8;
  const SILENCE_DELAY_MS  = 250;
  const MIN_CHUNK_MS      = 400;

  micAudioCtx       = new AudioContext();
  const source      = micAudioCtx.createMediaStreamSource(micStream);
  const analyser    = micAudioCtx.createAnalyser();
  analyser.fftSize  = 512;
  source.connect(analyser);
  const pcm = new Uint8Array(analyser.frequencyBinCount);

  function getRMS() {
    analyser.getByteTimeDomainData(pcm);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) { const v = (pcm[i] - 128) / 128; sum += v * v; }
    return Math.sqrt(sum / pcm.length) * 100;
  }

  let silenceAt  = null;
  let chunkStart = Date.now();

  function pollSilence() {
    if (!isRecording) return;
    const now = Date.now();
    if (getRMS() < SILENCE_THRESHOLD) {
      if (silenceAt === null) silenceAt = now;
      if (now - silenceAt >= SILENCE_DELAY_MS && now - chunkStart >= MIN_CHUNK_MS) {
        silenceAt = null;
        if (micRecorder?.state === 'recording') {
          clearTimeout(micTimer); micTimer = null;
          micRecorder.stop();
          return;
        }
      }
    } else {
      silenceAt = null;
    }
    setTimeout(pollSilence, 50);
  }

  function createRecorder() {
    const chunks = [];
    const rec    = new MediaRecorder(micStream, { mimeType });
    chunkStart   = Date.now();

    rec.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

    rec.onstop = async () => {
      if (!chunks.length || !isRecording) return;
      const blob = new Blob(chunks, { type: mimeType });
      sendMicToWhisper(blob);
      if (isRecording && micStream?.active) {
        micRecorder = createRecorder();
        setTimeout(pollSilence, 50);
      }
    };

    rec.start();
    youInterim.textContent = '🎙 listening…';
    micTimer = setTimeout(() => {
      if (rec.state === 'recording') rec.stop();
    }, cfg.chunkInterval * 1000);

    return rec;
  }

  micRecorder = createRecorder();
  pollSilence();
}

async function sendMicToWhisper(blob) {
  const form = new FormData();
  form.append('file',      blob, 'audio.webm');
  form.append('model',     cfg.model || 'base');
  form.append('max_words', cfg.splitWords ?? 8);
  if (cfg.language) form.append('language', cfg.language);

  try {
    const res = await fetch(`${cfg.endpoint}/v1/audio/transcriptions/stream`, {
      method: 'POST',
      body:   form,
    });
    if (!res.ok) {
      console.error('Whisper error:', res.status, await res.text());
      setPill(micPill, 'error', `Mic: server ${res.status}`);
      return;
    }

    const reader     = res.body.getReader();
    const decoder    = new TextDecoder();
    let lineBuffer   = '';

    youInterim.textContent = '⏳ transcribing…';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      const lines = lineBuffer.split('\n');
      lineBuffer  = lines.pop();
      for (const line of lines) {
        const text = line.trim();
        if (text) {
          youInterim.textContent = text;
          addSegments(text);
        }
      }
    }
    const remaining = lineBuffer.trim();
    if (remaining) { youInterim.textContent = remaining; addSegments(remaining); }
    youInterim.textContent = '';
    youInterimTranslation.textContent = '';
  } catch (err) {
    console.error('Whisper fetch error:', err);
    setPill(micPill, 'warn', 'Mic: server offline');
  }
}

function stopMic() {
  if (micTimer)   { clearTimeout(micTimer); micTimer = null; }
  if (micRecorder?.state === 'recording') { micRecorder.stop(); micRecorder = null; }
  if (micStream)  { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  if (micAudioCtx){ micAudioCtx.close(); micAudioCtx = null; }
  clearTimeout(_interimDebounce);
  if (_interimAbort) { _interimAbort.abort(); _interimAbort = null; }
  _lastInterimWords = 0;
  youInterim.textContent = '';
  youInterimTranslation.textContent = '';
  setPill(micPill, 'idle', 'Mic: idle');
}

// ── Pill helper ──────────────────────────────────────────────────
function setPill(el, state, text) {
  el.className   = `pill ${state}`;
  el.textContent = text;
}

// ── Start / Stop ─────────────────────────────────────────────────
async function startSession() {
  isRecording = true;
  toggleBtn.disabled    = true;
  toggleBtn.textContent = 'Starting...';
  logo.classList.add('recording');
  startTimer();
  await startMic();
  toggleBtn.textContent = 'Stop Recording';
  toggleBtn.className   = 'btn-stop';
  toggleBtn.disabled    = false;
}

function stopSession() {
  isRecording = false;
  toggleBtn.disabled = true;
  stopMic();
  stopTimer();
  saveCurrentSession();
  logo.classList.remove('recording');
  toggleBtn.textContent = 'Start Recording';
  toggleBtn.className   = 'btn-start';
  toggleBtn.disabled    = false;
}

toggleBtn.addEventListener('click', () => {
  if (isRecording) stopSession();
  else             startSession();
});

// ── Session history (localStorage) ──────────────────────────────
const HISTORY_KEY = 'livetranscribe_history';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); }
  catch { return []; }
}
function saveHistory(sessions) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(sessions));
}

function saveCurrentSession() {
  if (!youSegs.length) return;
  const sessions = loadHistory();
  sessions.unshift({
    id:      Date.now(),
    savedAt: Date.now(),
    segs:    youSegs.map(s => ({ text: s.text, translation: s.translation, ts: s.ts })),
  });
  saveHistory(sessions.slice(0, 50));
}

function deleteSession(id) {
  saveHistory(loadHistory().filter(s => s.id !== id));
  renderHistoryPanel();
}

function renderHistoryPanel() {
  const sessions = loadHistory();
  const list = document.getElementById('history-list');
  if (!sessions.length) {
    list.innerHTML = '<p class="empty-hint">No saved sessions yet.</p>';
    return;
  }
  list.innerHTML = sessions.map(s => {
    const date    = new Date(s.savedAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const total   = s.segs?.length ?? (s.you?.length ?? 0) + (s.partner?.length ?? 0);
    const allSegs = s.segs ?? [...(s.you ?? []), ...(s.partner ?? [])];
    const preview = allSegs.sort((a,b) => a.ts - b.ts).slice(0,2).map(seg => esc(seg.text.slice(0,60))).join(' · ');
    return `<div class="hist-item" data-id="${s.id}">
      <div class="hist-meta">
        <span class="hist-date">${date}</span>
        <span class="hist-count">${total} segment${total !== 1 ? 's' : ''}</span>
        <button class="hist-delete icon-btn" data-id="${s.id}" title="Delete">🗑</button>
      </div>
      <div class="hist-preview">${preview || '(empty)'}</div>
      <button class="hist-load btn-secondary" data-id="${s.id}">Load</button>
    </div>`;
  }).join('');

  list.querySelectorAll('.hist-delete').forEach(btn => {
    btn.addEventListener('click', e => { e.stopPropagation(); deleteSession(Number(btn.dataset.id)); });
  });
  list.querySelectorAll('.hist-load').forEach(btn => {
    btn.addEventListener('click', () => loadSession(Number(btn.dataset.id)));
  });
}

function loadSession(id) {
  const session = loadHistory().find(s => s.id === id);
  if (!session) return;

  youSegs.length = 0;
  youBody.innerHTML = '';
  youInterim.textContent = '';

  const segs = session.segs ?? [...(session.you ?? []), ...(session.partner ?? [])];
  segs.sort((a,b) => a.ts - b.ts).forEach(s => {
    youSegs.push({ ...s, id: s.ts + Math.random() });
    const t  = new Date(s.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    const el = document.createElement('div');
    el.className = 'seg';
    el.innerHTML = `<span class="seg-text">${esc(s.text)}</span>`
      + (s.translation ? `<span class="seg-translation">${esc(s.translation)}</span>` : `<span class="seg-translation"></span>`)
      + `<span class="seg-time">${t}</span>`;
    youBody.appendChild(el);
  });

  if (!youSegs.length) youBody.innerHTML = '<p class="empty-hint">Your speech will appear here.</p>';
  closeHistory();
}

function openHistory() {
  renderHistoryPanel();
  document.getElementById('history-overlay').classList.remove('hidden');
}
function closeHistory() {
  document.getElementById('history-overlay').classList.add('hidden');
}

// ── Clear / Copy ─────────────────────────────────────────────────
clearBtn.addEventListener('click', () => {
  youSegs.length = 0;
  youBody.innerHTML = '<p class="empty-hint">Your speech will appear here.</p>';
  youInterim.textContent = '';
  youInterimTranslation.textContent = '';
});

copyBtn.addEventListener('click', async () => {
  const text = youSegs
    .sort((a,b) => a.ts - b.ts)
    .map(s => {
      const t = new Date(s.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
      return `[${t}] ${s.text}`;
    }).join('\n');
  await navigator.clipboard.writeText(text || '(empty)');
  copyBtn.textContent = '✓';
  setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
});

// ── Settings panel ────────────────────────────────────────────────
function openSettings() {
  sEndpoint.value              = cfg.endpoint;
  sModel.value                 = cfg.model;
  sChunk.value                 = cfg.chunkInterval;
  sChunkLabel.textContent      = `${cfg.chunkInterval} s`;
  sSplitWords.value            = cfg.splitWords;
  sSplitWordsLabel.textContent = `${cfg.splitWords} words`;
  sLanguage.value              = cfg.language;
  sTestResult.textContent      = '';
  sTestResult.className        = 'test-result';

  sTranslationEnabled.checked    = cfg.translationEnabled;
  sOllamaUrl.value               = cfg.ollamaUrl;
  sOllamaModel.value             = cfg.ollamaModel;
  sTargetLang.value              = cfg.targetLang;
  sOllamaTestResult.textContent  = '';
  sOllamaTestResult.className    = 'test-result';

  overlay.classList.remove('hidden');
}
function closeSettings() { overlay.classList.add('hidden'); }

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });

sChunk.addEventListener('input', () => { sChunkLabel.textContent = `${sChunk.value} s`; });
sSplitWords.addEventListener('input', () => { sSplitWordsLabel.textContent = `${sSplitWords.value} words`; });

sTest.addEventListener('click', async () => {
  const url = sEndpoint.value.trim() || cfg.endpoint;
  sTestResult.textContent = 'Testing...';
  sTestResult.className   = 'test-result';
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      const d = await res.json();
      sTestResult.textContent = `✓ Online — model: ${d.model || 'unknown'}`;
      sTestResult.classList.add('ok');
    } else {
      sTestResult.textContent = `✗ HTTP ${res.status}`;
      sTestResult.classList.add('err');
    }
  } catch (err) {
    sTestResult.textContent = `✗ ${err.message}`;
    sTestResult.classList.add('err');
  }
});

sSave.addEventListener('click', () => {
  cfg = {
    endpoint:           sEndpoint.value.trim()    || defaultCfg().endpoint,
    model:              sModel.value,
    chunkInterval:      Number(sChunk.value),
    splitWords:         Number(sSplitWords.value),
    language:           sLanguage.value.trim(),
    translationEnabled: sTranslationEnabled.checked,
    ollamaUrl:          sOllamaUrl.value.trim()   || defaultCfg().ollamaUrl,
    ollamaModel:        sOllamaModel.value.trim() || defaultCfg().ollamaModel,
    targetLang:         sTargetLang.value.trim()  || defaultCfg().targetLang,
  };
  saveCfg(cfg);
  sSaved.textContent = 'Saved!';
  setTimeout(() => { sSaved.textContent = ''; }, 2000);
  checkServer();
  checkOllama();
});

sOllamaTest.addEventListener('click', async () => {
  const url = sEndpoint.value.trim() || cfg.endpoint;
  sOllamaTestResult.textContent = 'Testing…';
  sOllamaTestResult.className   = 'test-result';
  try {
    const res = await fetch(`${url}/ollama/health`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const d = await res.json();
      sOllamaTestResult.textContent = `✓ Online — model: ${d.active_model}, available: ${(d.models || []).join(', ') || 'none'}`;
      sOllamaTestResult.classList.add('ok');
    } else {
      sOllamaTestResult.textContent = `✗ HTTP ${res.status}`;
      sOllamaTestResult.classList.add('err');
    }
  } catch (err) {
    sOllamaTestResult.textContent = `✗ ${err.message}`;
    sOllamaTestResult.classList.add('err');
  }
});

// ── History panel events ─────────────────────────────────────────
document.getElementById('history-btn').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', closeHistory);
document.getElementById('history-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('history-overlay')) closeHistory();
});
document.getElementById('history-clear-all').addEventListener('click', () => {
  if (confirm('Delete all saved sessions?')) { saveHistory([]); renderHistoryPanel(); }
});

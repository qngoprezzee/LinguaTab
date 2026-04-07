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
    endpoint:           'http://127.0.0.1:5000',
    model:              'base',
    chunkInterval:      5,
    language:           '',
    micLang:            'en-US',
    translationEnabled: false,
    ollamaUrl:          'http://localhost:11434',
    ollamaModel:        'llama3',
    targetLang:         'English',
    translateSide:      'both',
  };
}

let cfg = loadCfg();

// ── DOM refs ─────────────────────────────────────────────────────
const logo          = document.getElementById('logo');
const serverBadge   = document.getElementById('server-badge');
const toggleBtn     = document.getElementById('toggle-btn');
const micPill       = document.getElementById('mic-pill');
const tabPill       = document.getElementById('tab-pill');
const timerEl       = document.getElementById('timer-el');
const youBody       = document.getElementById('you-body');
const partnerBody   = document.getElementById('partner-body');
const youInterim                 = document.getElementById('you-interim');
const youInterimTranslation      = document.getElementById('you-interim-translation');
const partnerInterim             = document.getElementById('partner-interim');
const partnerInterimTranslation  = document.getElementById('partner-interim-translation');
const clearBtn      = document.getElementById('clear-btn');
const copyBtn       = document.getElementById('copy-btn');
const settingsBtn   = document.getElementById('settings-btn');
const overlay       = document.getElementById('settings-overlay');
const settingsClose = document.getElementById('settings-close');

// Settings inputs
const sEndpoint   = document.getElementById('s-endpoint');
const sModel      = document.getElementById('s-model');
const sChunk      = document.getElementById('s-chunk');
const sChunkLabel = document.getElementById('s-chunk-label');
const sLanguage   = document.getElementById('s-language');
const sMicLang    = document.getElementById('s-mic-lang');
const sTest       = document.getElementById('s-test');
const sTestResult = document.getElementById('s-test-result');
const sSave       = document.getElementById('s-save');
const sSaved      = document.getElementById('s-saved');

// Translation settings inputs
const sTranslationEnabled = document.getElementById('s-translation-enabled');
const sOllamaUrl          = document.getElementById('s-ollama-url');
const sOllamaModel        = document.getElementById('s-ollama-model');
const sTargetLang         = document.getElementById('s-target-lang');
const sTranslateSide      = document.getElementById('s-translate-side');
const sOllamaTest         = document.getElementById('s-ollama-test');
const sOllamaTestResult   = document.getElementById('s-ollama-test-result');
const ollamaBadge         = document.getElementById('ollama-badge');


// ── State ────────────────────────────────────────────────────────
let isRecording    = false;
let sessionStart   = null;
let timerInterval  = null;

let micStream      = null;
let micRecognition = null;

let partnerStream   = null;
let partnerRecorder = null;
let partnerTimer    = null;
let partnerAudioCtx = null;

const youSegs     = [];   // { id, text, ts }
const partnerSegs = [];

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

// Poll every 8 s
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

// Split a block of text into natural sentence-sized pieces.
// Splits on: . ! ? — and also on commas/conjunctions when a chunk > 120 chars.
function splitSentences(text) {
  // First split on strong sentence-ending punctuation
  const parts = text
    .split(/(?<=[.!?。？！])\s+/)
    .flatMap(chunk => {
      chunk = chunk.trim();
      if (!chunk) return [];
      // If still long (> 120 chars), split further on comma/semicolon boundaries
      if (chunk.length > 120) {
        return chunk
          .split(/(?<=[,;،،])\s+/)
          .map(s => s.trim())
          .filter(Boolean);
      }
      return [chunk];
    })
    .filter(Boolean);

  return parts.length ? parts : [text];
}

function addSegment(bodyEl, segArr, text) {
  const seg = { id: Date.now() + Math.random(), text, translation: '', ts: Date.now() };
  segArr.push(seg);

  // Remove placeholder
  bodyEl.querySelector('.empty-hint')?.remove();

  const d  = new Date(seg.ts);
  const t  = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const el = document.createElement('div');
  el.className = 'seg';
  el.innerHTML = `<span class="seg-text">${esc(text)}</span>`
    + `<span class="seg-translation"></span>`
    + `<span class="seg-time">${t}</span>`;
  bodyEl.appendChild(el);
  bodyEl.scrollTop = bodyEl.scrollHeight;
  return { el, seg };
}

function addSegments(bodyEl, segArr, text, side) {
  splitSentences(text).forEach(sentence => {
    const { el, seg } = addSegment(bodyEl, segArr, sentence);
    if (cfg.translateSide === 'both' || cfg.translateSide === side) {
      translateSegment(sentence, el, seg);
    }
  });
}

// ── Translation ──────────────────────────────────────────────────
async function translateSegment(text, segEl, seg) {
  if (!cfg.translationEnabled || !text) return;
  const translEl = segEl.querySelector('.seg-translation');
  if (!translEl) return;

  translEl.textContent = '';
  translEl.classList.add('loading');
  translEl.classList.remove('error');

  const body = JSON.stringify({
    text,
    target_lang: cfg.targetLang,
    model:       cfg.ollamaModel,
    ollama_url:  cfg.ollamaUrl,
  });

  try {
    const res = await fetch(`${cfg.endpoint}/v1/translate/stream`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
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
      // keep column scrolled to bottom as tokens arrive
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

// ── Interim translation (debounced) ─────────────────────────────
let _interimDebounce  = null;
let _interimAbort     = null;
let _lastInterimWords = 0;   // word count when we last fired a translation

function translateInterim(text) {
  if (!cfg.translationEnabled || !text ||
      (cfg.translateSide !== 'both' && cfg.translateSide !== 'you')) return;

  const wordCount = text.trim().split(/\s+/).length;

  // Skip if no new word has been added since the last request
  if (wordCount <= _lastInterimWords) return;

  clearTimeout(_interimDebounce);
  _interimDebounce = setTimeout(async () => {
    if (_interimAbort) _interimAbort.abort();
    _interimAbort = new AbortController();
    _lastInterimWords = wordCount;

    // Don't blank the display — keep previous translation visible until first token arrives
    try {
      const res = await fetch(`${cfg.endpoint}/v1/translate/stream`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          text,
          target_lang: cfg.targetLang,
          model:       cfg.ollamaModel,
          ollama_url:  cfg.ollamaUrl,
        }),
        signal: _interimAbort.signal,
      });
      if (!res.ok) { youInterimTranslation.textContent = ''; return; }

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let out = '';
      let firstToken = true;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (firstToken) {
          // Only replace previous translation when new one actually starts arriving
          youInterimTranslation.textContent = '';
          firstToken = false;
        }
        out += chunk;
        youInterimTranslation.textContent = out;
      }
    } catch (e) {
      if (e.name !== 'AbortError') youInterimTranslation.textContent = '';
    }
  }, 150);
}

// ── Mic pipeline — Web Speech API ────────────────────────────────
async function startMic() {
  setPill(micPill, 'idle', 'Mic: requesting...');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    const msg = err.name === 'NotAllowedError'  ? 'Mic: permission denied' :
                err.name === 'NotFoundError'    ? 'Mic: not found' :
                err.name === 'NotReadableError' ? 'Mic: in use by another app' :
                err.name === 'SecurityError'    ? 'Mic: needs http://localhost' :
                                                  `Mic: ${err.name}`;
    setPill(micPill, 'error', msg);
    console.error('Mic getUserMedia failed:', err);
    return;
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setPill(micPill, 'error', 'Mic: not supported');
    return;
  }

  micRecognition = new SR();
  micRecognition.continuous     = true;
  micRecognition.interimResults = true;
  micRecognition.lang           = cfg.micLang || 'en-US';

  micRecognition.onstart = () => setPill(micPill, 'active', 'Mic: listening');

  micRecognition.onresult = event => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i];
      if (r.isFinal) {
        const text = r[0].transcript.trim();
        clearTimeout(_interimDebounce);
        if (_interimAbort) { _interimAbort.abort(); _interimAbort = null; }
        _lastInterimWords = 0;
        youInterimTranslation.textContent = '';
        if (text) addSegments(youBody, youSegs, text, 'you');
        youInterim.textContent = '';
      } else {
        interim += r[0].transcript;
      }
    }
    if (interim) {
      youInterim.textContent = interim;
      translateInterim(interim);
    }
  };

  micRecognition.onerror = e => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    setPill(micPill, 'error', `Mic: ${e.error}`);
  };

  micRecognition.onend = () => {
    if (isRecording) {
      try { micRecognition.start(); } catch (_) {}
    } else {
      setPill(micPill, 'idle', 'Mic: idle');
    }
  };

  micRecognition.start();
}

function stopMic() {
  if (micRecognition) { try { micRecognition.stop(); } catch (_) {} micRecognition = null; }
  if (micStream)      { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
  clearTimeout(_interimDebounce);
  if (_interimAbort) { _interimAbort.abort(); _interimAbort = null; }
  _lastInterimWords = 0;
  youInterim.textContent = '';
  youInterimTranslation.textContent = '';
  setPill(micPill, 'idle', 'Mic: idle');
}

// ── Partner pipeline — getDisplayMedia → local Whisper ───────────
async function startPartner() {
  setPill(tabPill, 'idle', 'Partner: requesting...');

  // getDisplayMedia captures tab/window/system audio.
  // Chrome requires video:true in the request; we drop the video track immediately.
  let displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: true,    // required by Chrome to show the picker
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        sampleRate: 16000,
      },
      preferCurrentTab: true,   // Chrome 107+ hints to pre-select current tab
    });
  } catch (err) {
    // User cancelled or denied
    setPill(tabPill, 'warn', 'Partner: not shared');
    console.warn('getDisplayMedia cancelled/denied:', err.message);
    return;
  }

  // Drop video track — we only need audio
  displayStream.getVideoTracks().forEach(t => t.stop());

  const audioTracks = displayStream.getAudioTracks();
  if (!audioTracks.length) {
    setPill(tabPill, 'warn', 'Partner: no audio track');
    console.warn('No audio track in display stream. Did you check "Share tab audio"?');
    return;
  }

  partnerStream = new MediaStream(audioTracks);

  const serverOnline = await checkServer();
  if (!serverOnline) {
    setPill(tabPill, 'warn', 'Partner: server offline');
    return;
  }

  setPill(tabPill, 'active', 'Partner: transcribing');
  startPartnerRecorder();

  // If the user stops sharing from the browser's own UI, clean up gracefully
  audioTracks[0].addEventListener('ended', () => {
    if (isRecording) stopPartner();
  });
}

function startPartnerRecorder() {
  const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
    ? 'audio/webm;codecs=opus' : 'audio/webm';

  // ── Silence detection via Web Audio ────────────────────────────
  const SILENCE_THRESHOLD = 8;    // RMS 0-100; below = silence
  const SILENCE_DELAY_MS  = 500;  // ms of silence before flushing
  const MIN_CHUNK_MS      = 1000; // never flush shorter than this

  partnerAudioCtx       = new AudioContext();
  const source          = partnerAudioCtx.createMediaStreamSource(partnerStream);
  const analyser        = partnerAudioCtx.createAnalyser();
  analyser.fftSize      = 512;
  source.connect(analyser);
  const pcm             = new Uint8Array(analyser.frequencyBinCount);

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
    const now     = Date.now();
    const elapsed = now - chunkStart;

    if (getRMS() < SILENCE_THRESHOLD) {
      if (silenceAt === null) silenceAt = now;
      if (now - silenceAt >= SILENCE_DELAY_MS && elapsed >= MIN_CHUNK_MS) {
        // Pause detected — flush chunk early
        silenceAt = null;
        if (partnerRecorder?.state === 'recording') {
          clearTimeout(partnerTimer);
          partnerTimer = null;
          partnerRecorder.stop();  // onstop restarts the recorder
          return;                  // resume polling after new recorder starts
        }
      }
    } else {
      silenceAt = null;
    }
    setTimeout(pollSilence, 50);
  }

  // ── Recorder lifecycle ──────────────────────────────────────────
  function createRecorder() {
    const chunks = [];
    const rec    = new MediaRecorder(partnerStream, { mimeType });
    chunkStart   = Date.now();

    rec.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

    rec.onstop = async () => {
      if (!chunks.length || !isRecording) return;
      const blob = new Blob(chunks, { type: mimeType });
      sendToWhisper(blob);           // fire-and-forget; don't block next chunk
      if (isRecording && partnerStream?.active) {
        partnerRecorder = createRecorder();
        setTimeout(pollSilence, 50); // resume silence polling for new chunk
      }
    };

    rec.start();
    partnerInterim.textContent = '🎙 listening…';
    partnerInterimTranslation.textContent = '';
    // Hard cap: flush after chunkInterval regardless of silence
    partnerTimer = setTimeout(() => {
      if (rec.state === 'recording') rec.stop();
    }, cfg.chunkInterval * 1000);

    return rec;
  }

  partnerRecorder = createRecorder();
  pollSilence();
}

async function sendToWhisper(blob) {
  const form = new FormData();
  form.append('file',  blob, 'audio.webm');
  form.append('model', cfg.model || 'base');
  if (cfg.language) form.append('language', cfg.language);

  try {
    const res = await fetch(`${cfg.endpoint}/v1/audio/transcriptions/stream`, {
      method: 'POST',
      body:   form,
    });
    if (!res.ok) {
      console.error('Whisper error:', res.status, await res.text());
      setPill(tabPill, 'error', `Partner: server ${res.status}`);
      return;
    }

    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = '';

    partnerInterim.textContent = '⏳ transcribing…';
    partnerInterimTranslation.textContent = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      lineBuffer += decoder.decode(value, { stream: true });
      // Each server line is one Whisper segment — process as soon as a full line arrives
      const lines = lineBuffer.split('\n');
      lineBuffer  = lines.pop(); // keep incomplete trailing fragment
      for (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        // Flash the incoming segment in the interim bar, then commit it
        partnerInterim.textContent = text;
        addSegments(partnerBody, partnerSegs, text, 'partner');
      }
    }
    // Flush any remaining text (segment without trailing newline)
    const remaining = lineBuffer.trim();
    if (remaining) {
      partnerInterim.textContent = remaining;
      addSegments(partnerBody, partnerSegs, remaining, 'partner');
    }
    partnerInterim.textContent = '';
    partnerInterimTranslation.textContent = '';
  } catch (err) {
    console.error('Whisper fetch error:', err);
    setPill(tabPill, 'warn', 'Partner: server offline');
  }
}

function stopPartner() {
  if (partnerTimer)    { clearTimeout(partnerTimer); partnerTimer = null; }
  if (partnerRecorder?.state === 'recording') { partnerRecorder.stop(); partnerRecorder = null; }
  if (partnerStream)   { partnerStream.getTracks().forEach(t => t.stop()); partnerStream = null; }
  if (partnerAudioCtx) { partnerAudioCtx.close(); partnerAudioCtx = null; }
  partnerInterim.textContent = '';
  partnerInterimTranslation.textContent = '';
  setPill(tabPill, 'idle', 'Partner: idle');
}

// ── Pill helper ──────────────────────────────────────────────────
function setPill(el, state, text) {
  el.className  = `pill ${state}`;
  el.textContent = text;
}

// ── Start / Stop ─────────────────────────────────────────────────
async function startSession() {
  isRecording = true;
  toggleBtn.disabled = true;
  toggleBtn.textContent = 'Starting...';
  logo.classList.add('recording');
  startTimer();

  await Promise.all([ startMic(), startPartner() ]);

  toggleBtn.textContent = 'Stop Recording';
  toggleBtn.className   = 'btn-stop';
  toggleBtn.disabled    = false;
}

function stopSession() {
  isRecording = false;
  toggleBtn.disabled = true;

  stopMic();
  stopPartner();
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
  if (!youSegs.length && !partnerSegs.length) return;
  const sessions = loadHistory();
  sessions.unshift({
    id:        Date.now(),
    savedAt:   Date.now(),
    you:       youSegs.map(s => ({ text: s.text, translation: s.translation, ts: s.ts })),
    partner:   partnerSegs.map(s => ({ text: s.text, translation: s.translation, ts: s.ts })),
  });
  // Keep last 50 sessions
  saveHistory(sessions.slice(0, 50));
}

function deleteSession(id) {
  const sessions = loadHistory().filter(s => s.id !== id);
  saveHistory(sessions);
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
    const date  = new Date(s.savedAt).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    const total = s.you.length + s.partner.length;
    const preview = [...s.you, ...s.partner]
      .sort((a, b) => a.ts - b.ts)
      .slice(0, 2)
      .map(seg => esc(seg.text.slice(0, 60)))
      .join(' · ');
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
    btn.addEventListener('click', e => {
      e.stopPropagation();
      deleteSession(Number(btn.dataset.id));
    });
  });

  list.querySelectorAll('.hist-load').forEach(btn => {
    btn.addEventListener('click', () => loadSession(Number(btn.dataset.id)));
  });
}

function loadSession(id) {
  const session = loadHistory().find(s => s.id === id);
  if (!session) return;

  // Clear current
  youSegs.length = partnerSegs.length = 0;
  youBody.innerHTML     = '';
  partnerBody.innerHTML = '';
  youInterim.textContent = '';

  // Replay you segments
  session.you.forEach(s => {
    youSegs.push({ ...s, id: s.ts + Math.random() });
    const d  = new Date(s.ts);
    const t  = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const el = document.createElement('div');
    el.className = 'seg';
    el.innerHTML = `<span class="seg-text">${esc(s.text)}</span>`
      + (s.translation ? `<span class="seg-translation">${esc(s.translation)}</span>` : `<span class="seg-translation"></span>`)
      + `<span class="seg-time">${t}</span>`;
    youBody.appendChild(el);
  });

  // Replay partner segments
  session.partner.forEach(s => {
    partnerSegs.push({ ...s, id: s.ts + Math.random() });
    const d  = new Date(s.ts);
    const t  = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const el = document.createElement('div');
    el.className = 'seg';
    el.innerHTML = `<span class="seg-text">${esc(s.text)}</span>`
      + (s.translation ? `<span class="seg-translation">${esc(s.translation)}</span>` : `<span class="seg-translation"></span>`)
      + `<span class="seg-time">${t}</span>`;
    partnerBody.appendChild(el);
  });

  if (!youSegs.length)     youBody.innerHTML     = '<p class="empty-hint">Your speech will appear here.</p>';
  if (!partnerSegs.length) partnerBody.innerHTML = '<p class="empty-hint">Partner speech appears here.<br><small>Share a tab or window audio when prompted.</small></p>';

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
  youSegs.length = partnerSegs.length = 0;
  youBody.innerHTML     = '<p class="empty-hint">Your speech will appear here.</p>';
  partnerBody.innerHTML = '<p class="empty-hint">Partner speech appears here.<br><small>Share a tab or window audio when prompted.</small></p>';
  youInterim.textContent = '';
});

copyBtn.addEventListener('click', async () => {
  const all = [
    ...youSegs.map(s => ({ ...s, side: 'You' })),
    ...partnerSegs.map(s => ({ ...s, side: 'Partner' })),
  ].sort((a, b) => a.ts - b.ts);

  const text = all.map(s => {
    const t = new Date(s.ts).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    return `[${t}] ${s.side}: ${s.text}`;
  }).join('\n');

  await navigator.clipboard.writeText(text || '(empty)');
  copyBtn.textContent = '✓';
  setTimeout(() => { copyBtn.textContent = '📋'; }, 1500);
});

// ── Settings panel ────────────────────────────────────────────────
function openSettings() {
  sEndpoint.value       = cfg.endpoint;
  sModel.value          = cfg.model;
  sChunk.value          = cfg.chunkInterval;
  sChunkLabel.textContent = `${cfg.chunkInterval} s`;
  sLanguage.value       = cfg.language;
  sMicLang.value        = cfg.micLang;
  sTestResult.textContent = '';
  sTestResult.className   = 'test-result';

  sTranslationEnabled.checked = cfg.translationEnabled;
  sOllamaUrl.value            = cfg.ollamaUrl;
  sOllamaModel.value          = cfg.ollamaModel;
  sTargetLang.value           = cfg.targetLang;
  sTranslateSide.value        = cfg.translateSide;
  sOllamaTestResult.textContent = '';
  sOllamaTestResult.className   = 'test-result';

  overlay.classList.remove('hidden');
}

function closeSettings() { overlay.classList.add('hidden'); }

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
overlay.addEventListener('click', e => { if (e.target === overlay) closeSettings(); });

sChunk.addEventListener('input', () => {
  sChunkLabel.textContent = `${sChunk.value} s`;
});


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
    language:           sLanguage.value.trim(),
    micLang:            sMicLang.value.trim()     || defaultCfg().micLang,
    translationEnabled: sTranslationEnabled.checked,
    ollamaUrl:          sOllamaUrl.value.trim()   || defaultCfg().ollamaUrl,
    ollamaModel:        sOllamaModel.value.trim() || defaultCfg().ollamaModel,
    targetLang:         sTargetLang.value.trim()  || defaultCfg().targetLang,
    translateSide:      sTranslateSide.value,
  };
  saveCfg(cfg);
  sSaved.textContent = 'Saved!';
  setTimeout(() => { sSaved.textContent = ''; }, 2000);
  checkServer();
  checkOllama();
});

// ── History panel events ─────────────────────────────────────────
document.getElementById('history-btn').addEventListener('click', openHistory);
document.getElementById('history-close').addEventListener('click', closeHistory);
document.getElementById('history-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('history-overlay')) closeHistory();
});
document.getElementById('history-clear-all').addEventListener('click', () => {
  if (confirm('Delete all saved sessions?')) {
    saveHistory([]);
    renderHistoryPanel();
  }
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

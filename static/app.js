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
    chunkInterval:      10,
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
const youInterim    = document.getElementById('you-interim');
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

let partnerStream  = null;
let partnerRecorder = null;
let partnerTimer   = null;

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

function addSegment(bodyEl, segArr, text) {
  const seg = { id: Date.now() + Math.random(), text, ts: Date.now() };
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
  return el;
}

// ── Translation ──────────────────────────────────────────────────
async function translateSegment(text, segEl) {
  if (!cfg.translationEnabled || !text) return;
  const translEl = segEl.querySelector('.seg-translation');
  if (!translEl) return;

  translEl.textContent = 'Translating…';
  translEl.classList.add('loading');

  try {
    const res = await fetch(`${cfg.endpoint}/v1/translate`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text,
        target_lang: cfg.targetLang,
        model:       cfg.ollamaModel,
        ollama_url:  cfg.ollamaUrl,
      }),
    });
    if (res.ok) {
      const { translation } = await res.json();
      translEl.textContent = translation || '';
      translEl.classList.remove('error');
    } else {
      const body = await res.json().catch(() => ({}));
      translEl.textContent = `⚠ ${body.detail || res.status}`;
      translEl.classList.add('error');
    }
  } catch (err) {
    translEl.textContent = `⚠ ${err.message}`;
    translEl.classList.add('error');
  }
  translEl.classList.remove('loading');
}

// ── Mic pipeline — Web Speech API ────────────────────────────────
async function startMic() {
  setPill(micPill, 'idle', 'Mic: requesting...');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (err) {
    setPill(micPill, 'error', 'Mic: blocked');
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
        if (text) {
          const el = addSegment(youBody, youSegs, text);
          if (cfg.translateSide === 'both' || cfg.translateSide === 'you') {
            translateSegment(text, el);
          }
        }
        youInterim.textContent = '';
      } else {
        interim += r[0].transcript;
      }
    }
    if (interim) youInterim.textContent = interim;
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
  youInterim.textContent = '';
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

  function createRecorder() {
    const chunks = [];
    const rec    = new MediaRecorder(partnerStream, { mimeType });

    rec.ondataavailable = e => { if (e.data?.size > 0) chunks.push(e.data); };

    rec.onstop = async () => {
      if (!chunks.length || !isRecording) return;
      const blob = new Blob(chunks, { type: mimeType });
      await sendToWhisper(blob);
      // Restart next window
      if (isRecording && partnerStream?.active) {
        partnerRecorder = createRecorder();
      }
    };

    rec.start();
    partnerTimer = setTimeout(() => {
      if (rec.state === 'recording') rec.stop();
    }, cfg.chunkInterval * 1000);

    return rec;
  }

  partnerRecorder = createRecorder();
}

async function sendToWhisper(blob) {
  const form = new FormData();
  form.append('file',  blob, 'audio.webm');
  form.append('model', cfg.model || 'base');
  if (cfg.language) form.append('language', cfg.language);

  try {
    const res = await fetch(`${cfg.endpoint}/v1/audio/transcriptions`, {
      method: 'POST',
      body:   form,
    });
    if (!res.ok) {
      console.error('Whisper error:', res.status, await res.text());
      setPill(tabPill, 'error', `Partner: server ${res.status}`);
      return;
    }
    const { text } = await res.json();
    const trimmed  = (text || '').trim();
    if (trimmed) {
      const el = addSegment(partnerBody, partnerSegs, trimmed);
      if (cfg.translateSide === 'both' || cfg.translateSide === 'partner') {
        translateSegment(trimmed, el);
      }
    }
  } catch (err) {
    console.error('Whisper fetch error:', err);
    setPill(tabPill, 'warn', 'Partner: server offline');
  }
}

function stopPartner() {
  if (partnerTimer) { clearTimeout(partnerTimer); partnerTimer = null; }
  if (partnerRecorder?.state === 'recording') { partnerRecorder.stop(); partnerRecorder = null; }
  if (partnerStream) { partnerStream.getTracks().forEach(t => t.stop()); partnerStream = null; }
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

  logo.classList.remove('recording');
  toggleBtn.textContent = 'Start Recording';
  toggleBtn.className   = 'btn-start';
  toggleBtn.disabled    = false;
}

toggleBtn.addEventListener('click', () => {
  if (isRecording) stopSession();
  else             startSession();
});

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

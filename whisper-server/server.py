#!/usr/bin/env python3
"""
LiveTranscribe — local Whisper server + static web app host.

Serves:
  GET  /              → static/index.html  (the web app)
  GET  /health        → { status, model }
  POST /v1/audio/transcriptions  → transcription (OpenAI-compatible)

Requirements:
    pip install faster-whisper fastapi uvicorn python-multipart

Usage:
    python server.py                   # base model, port 5000
    python server.py --model small     # better accuracy
    python server.py --model medium    # great accuracy, ~5 GB RAM
    python server.py --port 5001       # custom port

Available models (downloaded automatically to ~/.cache/huggingface/):
    tiny      ~75 MB   fastest
    base      ~145 MB  recommended ← default
    small     ~460 MB  better with accents / noise
    medium    ~1.5 GB  near-human accuracy
    large-v3  ~3 GB    best accuracy
"""

import argparse
import io
import json
import logging
import re
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import httpx
import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel
from pydantic import BaseModel

# ── CJK hallucination filter ──────────────────────────────────────────────────
# Languages that legitimately produce CJK characters
_CJK_LANGS = {'zh', 'ja', 'ko', 'yue', 'zh-TW', 'zh-CN'}
# Matches any CJK ideograph / kana / fullwidth block
_CJK_RE = re.compile(
    r'[\u3000-\u303f'   # CJK symbols & punctuation
    r'\u3040-\u309f'    # Hiragana
    r'\u30a0-\u30ff'    # Katakana
    r'\u4e00-\u9fff'    # CJK Unified Ideographs (core)
    r'\u3400-\u4dbf'    # CJK Extension A
    r'\uf900-\ufaff'    # CJK Compatibility Ideographs
    r'\uff00-\uffef]'   # Halfwidth/fullwidth forms
)

def _has_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text))

def _strip_cjk(text: str) -> str:
    """Remove CJK characters and collapse extra whitespace."""
    return re.sub(r'\s{2,}', ' ', _CJK_RE.sub('', text)).strip()

# ── Paths ──────────────────────────────────────────────────────────────────────
SERVER_DIR = Path(__file__).parent
STATIC_DIR = SERVER_DIR.parent / "static"

# ── Logging ────────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("livetranscribe")

# ── CLI args ───────────────────────────────────────────────────────────────────
parser = argparse.ArgumentParser(description="LiveTranscribe local server")
parser.add_argument("--model",        default="base",                   help="Whisper model size (default: base)")
parser.add_argument("--device",       default="auto",                   help="cpu | cuda | auto")
parser.add_argument("--port",         default=5000, type=int)
parser.add_argument("--host",         default="127.0.0.1")
parser.add_argument("--ollama-url",   default="http://localhost:11434", help="Ollama API base URL")
parser.add_argument("--ollama-model", default="llama3",                 help="Ollama model for translation")
args, _ = parser.parse_known_args()

# ── Model loading ──────────────────────────────────────────────────────────────
_model: Optional[WhisperModel] = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global _model
    device = args.device
    if device == "auto":
        try:
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"
        except ImportError:
            device = "cpu"

    compute = "float16" if device == "cuda" else "int8"
    log.info(f"Loading faster-whisper '{args.model}' on {device} ({compute}) ...")
    _model = WhisperModel(args.model, device=device, compute_type=compute)
    log.info("Model ready  ✓")
    yield
    _model = None

# ── App ────────────────────────────────────────────────────────────────────────
app = FastAPI(title="LiveTranscribe", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)

# Chrome Private Network Access — required for fetch() to 127.0.0.1 from Chrome 98+
@app.middleware("http")
async def private_network_access(request: Request, call_next):
    if request.method == "OPTIONS":
        response = Response(status_code=204)
        response.headers["Access-Control-Allow-Origin"]          = "*"
        response.headers["Access-Control-Allow-Methods"]         = "GET, POST, OPTIONS"
        response.headers["Access-Control-Allow-Headers"]         = "*"
        response.headers["Access-Control-Allow-Private-Network"] = "true"
        return response
    response = await call_next(request)
    response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response

# ── Models ─────────────────────────────────────────────────────────────────────
class TranslateRequest(BaseModel):
    text: str
    target_lang: str
    source_lang: str = ""
    model: str = ""         # overrides --ollama-model if provided
    ollama_url: str = ""    # overrides --ollama-url if provided

# ── API routes (registered BEFORE static mount so they take priority) ──────────
@app.get("/health")
def health():
    return {"status": "ok", "model": args.model}

@app.get("/ollama/health")
async def ollama_health():
    try:
        async with httpx.AsyncClient() as client:
            r = await client.get(f"{args.ollama_url}/api/tags", timeout=3.0)
            if r.status_code == 200:
                models = [m["name"] for m in r.json().get("models", [])]
                return {"status": "ok", "models": models, "active_model": args.ollama_model}
    except Exception:
        pass
    raise HTTPException(503, "Ollama not reachable")

def _build_prompt(req: TranslateRequest) -> str:
    src = f" from {req.source_lang}" if req.source_lang else ""
    return (
        f"You are a professional translator. Translate the text below{src} into {req.target_lang}.\n"
        f"Rules:\n"
        f"- Output ONLY the {req.target_lang} translation, nothing else.\n"
        f"- Do NOT use any other language or script in your response.\n"
        f"- Do NOT add explanations, notes, or punctuation that wasn't in the original.\n"
        f"- If a word has no direct translation, use the closest natural equivalent in {req.target_lang}.\n\n"
        f"Text:\n{req.text}\n\n"
        f"Translation in {req.target_lang}:"
    )

@app.post("/v1/translate")
async def translate(req: TranslateRequest):
    if not req.text.strip():
        return {"translation": ""}

    ollama_url   = req.ollama_url.rstrip("/") or args.ollama_url
    ollama_model = req.model or args.ollama_model
    log.info(f"Translating to '{req.target_lang}' via {ollama_model} ...")

    prompt = _build_prompt(req)

    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                f"{ollama_url}/api/generate",
                json={"model": ollama_model, "prompt": prompt, "stream": False},
                timeout=30.0,
            )
            r.raise_for_status()
            translation = r.json().get("response", "").strip()
            log.info(f"Translated ({req.target_lang}): {translation[:80]}")
            return {"translation": translation}
    except httpx.TimeoutException:
        raise HTTPException(504, "Ollama timed out")
    except Exception as e:
        log.error(f"Ollama error: {e}")
        raise HTTPException(502, f"Ollama error: {e}")

@app.post("/v1/translate/stream")
async def translate_stream(req: TranslateRequest):
    """Stream translation tokens as plain text chunks — first token arrives ~300ms."""
    if not req.text.strip():
        return Response("", media_type="text/plain")

    ollama_url   = req.ollama_url.rstrip("/") or args.ollama_url
    ollama_model = req.model or args.ollama_model
    log.info(f"Streaming translation to '{req.target_lang}' via {ollama_model} ...")

    prompt = _build_prompt(req)

    async def token_generator():
        try:
            async with httpx.AsyncClient() as client:
                async with client.stream(
                    "POST",
                    f"{ollama_url}/api/generate",
                    json={"model": ollama_model, "prompt": prompt, "stream": True},
                    timeout=30.0,
                ) as r:
                    async for line in r.aiter_lines():
                        if not line:
                            continue
                        try:
                            data = json.loads(line)
                        except Exception:
                            continue
                        token = data.get("response", "")
                        if token:
                            yield token
                        if data.get("done"):
                            break
        except Exception as e:
            log.error(f"Ollama stream error: {e}")

    return StreamingResponse(token_generator(), media_type="text/plain")

@app.post("/v1/audio/transcriptions")
async def transcribe(
    file:     UploadFile = File(...),
    model:    str        = Form("base"),
    language: str        = Form(""),
    prompt:   str        = Form(""),
):
    if _model is None:
        raise HTTPException(503, "Model not loaded yet — please wait")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio file")

    log.info(f"Transcribing  {len(audio_bytes)/1024:.1f} KB  lang={language or 'auto'}")

    segments, info = _model.transcribe(
        io.BytesIO(audio_bytes),
        language=language or None,
        initial_prompt=prompt or None,
        beam_size=5,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 300},
    )

    parts = []
    filter_cjk = info.language not in _CJK_LANGS
    for seg in segments:
        t = seg.text.strip()
        if filter_cjk and _has_cjk(t):
            t = _strip_cjk(t)
        if t:
            parts.append(t)
    text = " ".join(parts)
    log.info(f"Result ({info.language}, {info.duration:.1f}s): {text[:120]}")

    return {"text": text}

@app.post("/v1/audio/transcriptions/stream")
async def transcribe_stream(
    file:     UploadFile = File(...),
    model:    str        = Form("base"),
    language: str        = Form(""),
    prompt:   str        = Form(""),
):
    """Stream transcription segments as plain-text lines, one segment per line.
    Each line is flushed as soon as faster-whisper produces it, so the client
    can start translating early sentences while later ones are still being decoded.
    """
    if _model is None:
        raise HTTPException(503, "Model not loaded yet — please wait")

    audio_bytes = await file.read()
    if not audio_bytes:
        raise HTTPException(400, "Empty audio file")

    log.info(f"Stream-transcribing  {len(audio_bytes)/1024:.1f} KB  lang={language or 'auto'}")

    SENTENCE_END = frozenset('.!?。？！…')
    MAX_WORDS    = 12    # yield after this many words even without punctuation

    def segment_generator():
        segments, info = _model.transcribe(
            io.BytesIO(audio_bytes),
            language=language or None,
            initial_prompt=prompt or None,
            beam_size=5,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 300},
            word_timestamps=True,
            condition_on_previous_text=True,
        )
        # Filter CJK hallucinations when the detected language is not CJK
        filter_cjk = info.language not in _CJK_LANGS

        word_buf = []
        all_text = []
        for seg in segments:
            words = seg.words or []
            if not words:
                # no word timestamps — fall back to segment text
                text = seg.text.strip()
                if filter_cjk and _has_cjk(text):
                    text = _strip_cjk(text)
                if text:
                    all_text.append(text)
                    yield text + '\n'
                continue
            for w in words:
                token = w.word.strip()
                if not token:
                    continue
                # Drop CJK tokens entirely when they are hallucinations
                if filter_cjk and _has_cjk(token):
                    continue
                word_buf.append(token)
                all_text.append(token)
                last_char = token[-1]
                if last_char in SENTENCE_END or len(word_buf) >= MAX_WORDS:
                    yield ' '.join(word_buf) + '\n'
                    word_buf = []
        if word_buf:
            yield ' '.join(word_buf) + '\n'
        log.info(f"Stream done ({info.language}, {info.duration:.1f}s): {' '.join(all_text)[:120]}")

    return StreamingResponse(segment_generator(), media_type="text/plain")

# ── Serve the web app ──────────────────────────────────────────────────────────
if STATIC_DIR.exists():
    # Serve index.html for the root path explicitly
    @app.get("/")
    def index():
        return FileResponse(STATIC_DIR / "index.html")

    # Serve all other static assets (app.js, style.css, etc.)
    app.mount("/", StaticFiles(directory=STATIC_DIR), name="static")
else:
    log.warning(f"Static dir not found at {STATIC_DIR} — web app will not be served")

# ── Entry point ────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    log.info(f"Starting  http://{args.host}:{args.port}")
    if STATIC_DIR.exists():
        log.info(f"Web app   http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")

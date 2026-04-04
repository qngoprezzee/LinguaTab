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
import logging
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

import uvicorn
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from faster_whisper import WhisperModel

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
parser.add_argument("--model",  default="base",      help="Whisper model size (default: base)")
parser.add_argument("--device", default="auto",       help="cpu | cuda | auto")
parser.add_argument("--port",   default=5000, type=int)
parser.add_argument("--host",   default="127.0.0.1")
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

# ── API routes (registered BEFORE static mount so they take priority) ──────────
@app.get("/health")
def health():
    return {"status": "ok", "model": args.model}

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

    text = " ".join(seg.text.strip() for seg in segments).strip()
    log.info(f"Result ({info.language}, {info.duration:.1f}s): {text[:120]}")

    return {"text": text}

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

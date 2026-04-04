#!/usr/bin/env bash
# Start the local Whisper server.
# First run: installs dependencies into a venv automatically.

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$SCRIPT_DIR/.venv"

# ── Pick Python (prefer PYTHON env var, then python3.12/3.11/3.10, then python3)
PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
  for py in python3.12 python3.11 python3.10 python3; do
    if command -v "$py" &>/dev/null; then PYTHON="$py"; break; fi
  done
fi
echo "Using $($PYTHON --version)"

# ── Create venv if missing ────────────────────────────────────────
if [ ! -d "$VENV" ]; then
  echo "Creating virtual environment..."
  "$PYTHON" -m venv "$VENV"
fi

source "$VENV/bin/activate"

# ── Install / upgrade deps ────────────────────────────────────────
pip install -q --upgrade pip
pip install -q -r "$SCRIPT_DIR/requirements.txt"

# ── Launch ────────────────────────────────────────────────────────
echo ""
echo "  LiveTranscribe — Local Whisper Server"
echo "  Model : ${MODEL:-base}"
echo "  URL   : http://127.0.0.1:${PORT:-5000}"
echo "  Stop  : Ctrl+C"
echo ""

python "$SCRIPT_DIR/server.py" \
  --model "${MODEL:-base}" \
  --port  "${PORT:-5000}"  \
  "$@"

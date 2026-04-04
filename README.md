# LinguaTab

Live speech transcription and translation in your browser — fully local, no cloud APIs required.

- **Transcription** — [faster-whisper](https://github.com/SYSTRAN/faster-whisper) runs on your machine and handles tab/window audio via the browser's screen-share API
- **Mic recognition** — browser's built-in Web Speech API (no server needed)
- **Live translation** — [Ollama](https://ollama.com) translates each segment on the fly using a local LLM

---

## Requirements

| Tool | Version |
|------|---------|
| Python | 3.9+ |
| Ollama | any recent |
| Chrome / Edge | recommended (Firefox lacks `getDisplayMedia` audio support) |

---

## Setup

### 1. Clone

```zsh
git clone https://github.com/qngoprezzee/LinguaTab.git
cd LinguaTab
```

### 2. Whisper server

```zsh
cd whisper-server
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

### 3. Ollama (for live translation)

```zsh
brew install ollama
ollama serve          # run in a separate terminal
ollama pull llama3    # ~4.7 GB — or pick a smaller model below
```

**Smaller model options:**

| Model | Size | Command |
|-------|------|---------|
| `gemma3:1b` | ~815 MB | `ollama pull gemma3:1b` |
| `mistral` | ~4.1 GB | `ollama pull mistral` |
| `llama3` | ~4.7 GB | `ollama pull llama3` |

---

## Running

```zsh
# From whisper-server/ with .venv active
python server.py                    # base Whisper model, port 5000
python server.py --model small      # better accuracy
python server.py --ollama-model gemma3:1b   # use a specific Ollama model
```

Then open **http://127.0.0.1:5000** in your browser.

### Server flags

| Flag | Default | Description |
|------|---------|-------------|
| `--model` | `base` | Whisper model: `tiny`, `base`, `small`, `medium`, `large-v3` |
| `--device` | `auto` | `cpu`, `cuda`, or `auto` |
| `--port` | `5000` | HTTP port |
| `--host` | `127.0.0.1` | Bind address |
| `--ollama-url` | `http://localhost:11434` | Ollama API base URL |
| `--ollama-model` | `llama3` | Ollama model used for translation |

---

## Usage

1. Click **Start Recording** — the browser will ask for microphone and screen-share permissions
2. Select a tab or window and check **Share tab audio** when prompted (for Partner audio)
3. Your speech appears in the **You** column; shared-tab audio appears in the **Partner** column

### Live Translation

1. Open **Settings** (⚙ top-right)
2. Under **Live Translation (Ollama)**:
   - Enable the toggle
   - Set the target language (e.g. `English`, `Vietnamese`, `Spanish`)
   - Choose which side to translate: Both, Partner only, or You only
   - Click **Test** to verify Ollama is reachable
3. Click **Save** — translations appear in italic blue below each transcript segment

---

## Whisper models

| Model | Size | Notes |
|-------|------|-------|
| `tiny` | ~75 MB | Fastest |
| `base` | ~145 MB | Recommended default |
| `small` | ~460 MB | Better with accents / noise |
| `medium` | ~1.5 GB | Near-human accuracy |
| `large-v3` | ~3 GB | Best accuracy |

Models are downloaded automatically to `~/.cache/huggingface/` on first use.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Whisper server status |
| `GET` | `/ollama/health` | Ollama status + available models |
| `POST` | `/v1/audio/transcriptions` | OpenAI-compatible transcription |
| `POST` | `/v1/translate` | Translate text via Ollama |

---

## Project structure

```
LinguaTab/
├── static/
│   ├── index.html    # web app
│   ├── app.js        # recording, transcription, translation logic
│   └── style.css     # dark-theme UI
└── whisper-server/
    ├── server.py     # FastAPI server (Whisper + Ollama proxy)
    ├── requirements.txt
    └── start.sh
```

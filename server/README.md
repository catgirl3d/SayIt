<div align="center">

# 🎙️ SayIt

**Just say it, and write well**

Self-hosted speech-to-text server with real-time ASR and optional AI cleanup.

[Quick Start](#quick-start) · [Architecture](#architecture) · [Configuration](#configuration) · [Deployment](#deployment) · [License](#license)

</div>

---

## What is SayIt?

SayIt is a self-hosted speech-to-text service with configurable ASR engines (Qwen3-ASR, FireRedASR2, and Sber GigaAM) and optional AI cleanup. It provides:

- **Browser Demo** — Record and transcribe directly in the browser, no install needed
- **Windows Desktop Integration** — Push-to-talk clients can stream audio and receive cleaned text
- **REST & WebSocket API** — Integrate speech-to-text into your own applications
- **Session Telemetry** — Store usage and pipeline timings in SQLite or PostgreSQL

The ASR workload runs on the server GPU; the optional LLM and PostgreSQL services may be local or external.

## Features

- 🎯 **Real-time ASR** — Qwen3-ASR-1.7B by default, with FireRedASR2 and Sber GigaAM alternatives
- ✨ **AI Cleanup** — Optional written-text cleanup through OpenAI, Azure OpenAI, Groq, or Ollama
- 🔥 **Hotword Boosting** — Custom vocabulary for domain-specific terms
- 📊 **Session Telemetry** — Session analytics and performance measurements are persisted for operators
- 🐳 **Docker Ready** — `docker compose up` with GPU support, model baked into image
- 🔒 **Security** — Rate limiting and WebSocket connection limits
- 📦 **SQLite / PostgreSQL** — SQLite for single-node, PostgreSQL for cluster deployment

## Architecture

```
                    ┌────────────────────────────────────────────┐
                    │ Optional ALB / reverse proxy (HTTPS)       │
                    └──────────────────┬─────────────────────────┘
                                       │
                    ┌──────────────────▼─────────────────────────┐
                    │ FastAPI Backend (:8443 HTTPS by default)    │
                    │                                              │
                    │ /                 Landing page + demo        │
                    │ /api/*            REST APIs                  │
                    │ /ws/transcribe    WebSocket streaming        │
                    │                                              │
                    │ ┌──────────┐ ┌─────┐ ┌──────────────┐       │
                    │ │ASR       │ │ LLM │ │Telemetry     │       │
                    │ │Qwen3 /   │ │     │ │SQLite /      │       │
                    │ │FireRed / │ │     │ │PostgreSQL    │       │
                    │ │GigaAM    │ │     │ │              │       │
                    │ │(GPU)     │ │     │ │              │       │
                    │ └──────────┘ └─────┘ └──────────────┘       │
                    └────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- NVIDIA GPU; ≥16GB VRAM is recommended for the default Qwen3-ASR model (e.g., A10G, L4, RTX 4090)
- Docker with [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
- An LLM API key is optional; without one, the server runs ASR-only. Ollama can run locally without an API key.

### 1. Clone and configure

```bash
git clone https://github.com/catgirl3d/SayIt.git
cd SayIt/server
cp .env.example .env
cp config.example.yaml config.yaml
# If you edit config.yaml, uncomment its volume mount in docker-compose.yml.
```

Edit `.env` — fill in your API keys:
```bash
SAYIT_OPENAI_API_KEY=sk-...        # or SAYIT_GROQ_API_KEY
# Leave the LLM variables empty for ASR-only mode.
```

Edit `.env` to add provider credentials. The image includes the settings from `config.example.yaml`; if you need host-side configuration overrides, edit `config.yaml` and uncomment its volume mount in `docker-compose.yml`. The sample selects OpenAI for the desktop profile and Groq for the web demo. Missing credentials disable the corresponding LLM profile.

### 2. Start

```bash
docker compose up -d --build
```

The first build downloads several gigabytes of model weights and builds the image, so its duration depends on your network and hardware. Subsequent starts still spend time loading the models.

### 3. Access

| URL | Description |
|-----|-------------|
| `https://localhost:8443/` | Landing page + browser demo (Docker default) |
| `https://localhost:8443/healthz` | Health check (Docker default) |
| `http://localhost:8000/` | HTTP access when `SAYIT_TLS_ENABLED=false` |

## Project Layout

```
server/
├── backend/              # FastAPI backend
│   ├── app/
│   │   ├── main.py       # Routes, WebSocket handler
│   │   ├── config.py     # Nested config dataclasses
│   │   ├── asr.py        # ASR engines + VAD
│   │   ├── llm.py        # AI cleanup (multi-provider)
│   │   ├── telemetry.py  # Usage tracking + analytics
│   │   ├── db.py         # SQLite / PostgreSQL abstraction
│   │   └── ratelimit.py  # Token-bucket rate limiter
│   ├── tests/
│   ├── Dockerfile
│   └── requirements.txt
├── gateway/              # HTTPS reverse proxy (Node.js)
├── web/                  # Landing page and browser demo
├── prompts/              # System prompt + hotword files
├── config.example.yaml   # Configuration template
├── .env.example          # Secrets template
├── docker-compose.yml
└── LICENSE               # AGPL-3.0
```

## Configuration

Configuration is split into two files:

| File | Contains | Committed to git? |
|------|----------|-------------------|
| `config.example.yaml` | Committed configuration template | **Yes** |
| `config.yaml` | Local settings copied from the template | **No** |
| `.env` | Secrets only (API keys, passwords) | **No** |

All environment variables use the `SAYIT_` prefix. See [config.example.yaml](./config.example.yaml) for full documentation.

### Key settings

```yaml
asr:
  engine: "qwen3"                    # qwen3 / firered / gigaam
  model: "Qwen/Qwen3-ASR-1.7B"
  device: "cuda:0"

llm:
  desktop: "openai"
  web_demo: "groq"
  providers:
    openai:
      base_url: "https://api.openai.com"
      model: "gpt-4o-mini"
    groq:
      base_url: "https://api.groq.com/openai"
      model: "qwen/qwen3-32b"

web_demo:
  enabled: true
  max_duration_sec: 600              # Max recording per session
  max_concurrency_per_ip: 3

telemetry:
  enabled: true
  db: "sqlite"                         # sqlite / postgresql
  db_path: "runtime/telemetry/sayit.sqlite3"
```

### Database

Default: SQLite (zero config). For PostgreSQL or a multi-node deployment, select PostgreSQL in `config.yaml` and keep the connection URL in `.env`:

```yaml
telemetry:
  db: "postgresql"
```

```dotenv
SAYIT_DB_URL=postgresql://user:pass@host:5432/sayit
```

`db_path` is a filesystem path for SQLite; use `SAYIT_DB_URL` for a PostgreSQL DSN.

## Deployment

### Single server (recommended for most users)

```bash
docker compose up -d --build
```

### Behind an ALB or reverse proxy

1. Terminate TLS at the ALB or reverse proxy.
2. Set `SAYIT_TLS_ENABLED=false` in `.env`.
3. Forward requests to the container's HTTP port `8000`.
4. Use `/healthz` as the health check endpoint.

## Development

```bash
# Create virtualenv
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt

# Run backend directly
cd backend
uvicorn app.main:app --host 0.0.0.0 --port 8000

# Run tests
python -m pytest tests/ -v
```

## API

### WebSocket `/ws/transcribe`

```text
// → Client sends
{"cmd": "start", "client_meta": {"user_id": "..."}, "app_context": {"process_name": "..."}}
// → Client sends PCM audio frames (16kHz, 16-bit, mono)
{"cmd": "stop", "usage_meta": {"ptt_hold_ms": 1500}}

// ← Server responds
{"type": "asr", "text": "你好世界", "asr_ms": 450}
{"type": "final", "asr_text": "你好世界", "llm_text": "你好，世界。", "asr_ms": 450, "llm_ms": 320}
{"type": "done"}
```

### REST

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Health check |
| GET | `/api/public/config` | Public site configuration |
| GET | `/api/public/downloads/windows/latest` | Latest Windows client download |
| GET | `/api/notice` | Current client notice |
| POST | `/api/feedback` | Submit feedback |

Hotwords are loaded from `prompts/hotwords.txt` and can also be supplied per WebSocket session.

## License

This project is licensed under the [GNU Affero General Public License v3.0](./LICENSE).

You are free to self-host and modify SayIt. If you distribute a modified version or run it as a network service, you must make your source code available under the same license.

For commercial licensing inquiries, please contact the maintainers.

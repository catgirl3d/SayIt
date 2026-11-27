# 🎙️ SayIt Server on Windows: Setup & Desktop Connection

This guide runs the SayIt backend natively on Windows with the **Sber GigaAM** engine and connects the SayIt desktop app to it. For Docker, Linux, the other engines, the full configuration reference, and the API, see the [server README](../server/README.md).

---

## 1. Overview

- **Server:** the FastAPI backend (`server/backend/app/main.py`), started with uvicorn.
- **ASR engine:** Sber GigaAM (`v2_rnnt` or `v2_ctc`), a Russian speech recognition model. It runs on an NVIDIA GPU (tested on a GTX 1070 with 8 GB and CUDA 12.6) and falls back to the CPU when CUDA is unavailable; on the CPU, recognition was three to four times slower in the same test.
- **Why GigaAM:** Qwen3-ASR, the default engine, depends on vLLM, which does not run natively on Windows. For Qwen3-ASR, use Docker or WSL2.
- **Address:** `http://127.0.0.1:8000`, plain HTTP.
- **AI processing:** optional. Without LLM credentials the server returns the raw transcript.

---

## 2. Installing

Requirements: Python 3.12 and, for GPU inference, an NVIDIA GPU. Use exactly 3.12: the snapshot's NumPy and SciPy need 3.12 or newer, and its torch 2.11 fails to import on Python 3.13.8.

In PowerShell, from the repository root:

```powershell
cd server
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
pip install --no-deps --extra-index-url https://download.pytorch.org/whl/cu126 -r backend\requirements.gigaam-win.lock.txt
Copy-Item config.example.yaml config.yaml
python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

- `requirements.gigaam-win.lock.txt` is a tested snapshot of a working Windows GigaAM environment. `--no-deps` is required because GigaAM 0.1.0 declares stale dependency upper bounds, and the extra index serves the CUDA 12.6 builds of torch and torchaudio pinned in the snapshot, which PyPI does not host.
- The last command should print `2.11.0+cu126 True`. `False` means PyTorch cannot see the GPU, and the server will quietly run GigaAM on the CPU.
- If PowerShell refuses to run `Activate.ps1`, allow scripts for the current window with `Set-ExecutionPolicy -Scope Process Bypass` and run it again.

Then open `server\config.yaml` and switch the engine:

```yaml
asr:
  engine: "gigaam"
  device: "cuda:0"        # "cpu" without an NVIDIA GPU
  gigaam:
    model: "v2_rnnt"      # or "v2_ctc"
```

To enable AI processing, copy `.env.example` to `.env` in the same folder (`Copy-Item .env.example .env`) and add a provider key, as described in the [server README](../server/README.md#1-clone-and-configure).

---

## 3. Starting the Server

In PowerShell, from the repository root:

```powershell
cd server
.venv\Scripts\Activate.ps1
cd backend
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --no-proxy-headers
```

- The first start downloads the GigaAM weights (an internet connection is required) and then loads them, so it can take a while.
- uvicorn prints `Application startup complete` even when the model fails to load. Check [http://127.0.0.1:8000/healthz](http://127.0.0.1:8000/healthz): `"asr": true` means recognition is ready. If it is `false`, look for `ASR engine failed to load` in the console.
- A `VAD failed to load` traceback at startup is expected: the snapshot does not include funasr, so recordings longer than 25 seconds are split by audio energy instead of by voice activity detection.
- `--no-proxy-headers` keeps uvicorn from rewriting the client address: the application resolves `X-Forwarded-For` itself.
- To reach the server from other computers on your network, use `--host 0.0.0.0` and allow the port in Windows Firewall. Plain HTTP is unencrypted, so do this only on a network you trust.

---

## 4. Connect the Desktop App

Use an installed SayIt build, or run the client from source as described in the [README](../README.en.md#desktop-client).

1. **Processing mode:** open **Voice engine** and select the **Server mode** card.
2. **Server address:**
   - Server on the same computer:
     ```text
     http://127.0.0.1:8000
     ```
   - Server on another computer on your network (for example, a dedicated machine with a powerful GPU):
     ```text
     http://<SERVER_IP_ADDRESS>:8000
     ```
     *(for example, `http://192.168.1.100:8000`)*
3. **Verify the connection:** press **Save and test**.
4. **Success:** a confirmation appears below the address field. Without AI processing on the server, it reads:
   ```text
   Saved. Connected. This server only does speech recognition, with AI processing off — you'll get the raw transcript, unpolished. · ASR: Sber GigaAM (v2_rnnt)
   The current server backend ignores the explicit language.
   ```
   The second line is expected: GigaAM recognizes Russian regardless of the language chosen in the app.

A server running in Docker serves HTTPS with a self-signed certificate by default, which the desktop app does not trust; the [server README](../server/README.md#4-connect-the-desktop-app) lists the options.

---

## 5. Health Check & Troubleshooting

### Browser Verification

- **Web demo:** [http://127.0.0.1:8000/](http://127.0.0.1:8000/) — record and transcribe right in the browser.
- **Health check:** [http://127.0.0.1:8000/healthz](http://127.0.0.1:8000/healthz) — returns `"status": "ok"` along with whether speech recognition and AI processing are ready and which ASR model is loaded.

### Troubleshooting

1. **The app cannot connect:**
   - Make sure the uvicorn window is still open and `/healthz` shows `"asr": true`.
   - Check that the address starts with `http://`, not `https://`: this server runs plain HTTP.
   - Check the port: 8000 by default.
2. **Port 8000 is taken by another process:**
   - Start uvicorn with another `--port` and use the same port in the app's server address.
3. **Out of video memory (VRAM) or a CUDA error:**
   - Close other GPU-heavy programs, or set `device: "cpu"` in `server\config.yaml` and accept slower recognition.

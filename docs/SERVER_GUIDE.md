# 🎙️ SayIt Local Server Setup & Connection Guide

This guide covers running the local SayIt backend server powered by **Sber GigaAM** and connecting the SayIt desktop application to it.

---

## 1. Architecture & Engine

- **Server:** FastAPI (`server/backend/app/main.py`)
- **Default ASR Engine:** Sber GigaAM (`v2_rnnt`) on GPU (`cuda:0`)
- **Language:** Russian with Inverse Text Normalization (ITN enabled — formats numbers, dates, and currency)
- **Default Port:** `8000` (Address: `http://127.0.0.1:8000`)
- **Configuration File:** [`server/config.yaml`](../server/config.yaml)

---

## 2. Starting the Server

### Option 1: Quick Launch (Recommended)
Double-click [`launch_server.bat`](../launch_server.bat) in the root directory.

The script automatically:
1. Navigates to `server/backend`.
2. Activates the isolated Python virtual environment (`.venv`).
3. Launches the uvicorn web server at `http://127.0.0.1:8000`.

### Option 2: Manual Launch via Terminal
Open PowerShell or Command Prompt (CMD) and run:
```cmd
cd /d "e:\git_external\SayIt\server\backend"
call .venv\Scripts\activate.bat
python -m uvicorn app.main:app --host 127.0.0.1 --port 8000
```

---

## 3. Launching the SayIt Client App

To launch the desktop application:
- Double-click [`launch_sayit.bat`](../launch_sayit.bat) in the root directory.
- Or run in terminal:
  ```cmd
  cd /d "e:\git_external\SayIt\client"
  npm run tauri dev -- --no-watch
  ```

---

## 4. Configuring the SayIt Desktop App

After opening SayIt, go to the **Settings** window:

1. **Processing Mode:**
   - Select the **Server mode** card.
2. **Server Address:**
   - If running the server on the same machine:
     ```text
     http://127.0.0.1:8000
     ```
   - If running the server on another computer on the local network (e.g., a dedicated machine with a powerful GPU):
     ```text
     http://<SERVER_IP_ADDRESS>:8000
     ```
     *(for example, `http://192.168.1.100:8000`)*
3. **Verify Connection:**
   - Click the **Save and test** button.
4. **Successful Status:**
   - A green confirmation message will appear below the input field:
     ```text
     Saved. Connected. This server only does speech recognition, with AI cleanup off — you'll get the raw transcript, unpolished. · ASR: Sber GigaAM (v2_rnnt)
     ```
   - A green **• Connected** indicator will appear in the top-right corner of the mode selection panel.

---

## 5. Health Check & Diagnostics

### Browser Verification
You can open the following URLs in your browser:
- **Web Demo:** [http://127.0.0.1:8000/](http://127.0.0.1:8000/) — test audio recording and recognition directly in the browser.
- **Health Check Endpoint:** [http://127.0.0.1:8000/healthz](http://127.0.0.1:8000/healthz) — returns `{"status": "ok"}`.

### Troubleshooting

1. **`Connection refused` or `Not Connected` status in the app:**
   - Ensure the [`launch_server.bat`](../launch_server.bat) console window is open and that the model initialized without errors.
   - Verify that the URL uses the `http://` protocol instead of `https://` (local dev server uses plain HTTP).
   - Verify the port: default is `8000`.

2. **Port 8000 is occupied by another process:**
   - Change the port in [`server/config.yaml`](../server/config.yaml) under the `server.port` section, and update [`launch_server.bat`](../launch_server.bat) as well as the app settings accordingly.

3. **Out of Video Memory (VRAM) / CUDA Error:**
   - GigaAM (`v2_rnnt`) requires ~2–4 GB VRAM. Ensure your GPU has sufficient free memory and is not overloaded by other heavy processes.

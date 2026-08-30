# Contributing to SayIt

This repository is a maintained fork of SayIt. Focused bug fixes, feature work,
documentation updates, and translations are welcome.

## Issues

Open an issue for bugs, feature proposals, or usability feedback. Include:

- Windows version
- SayIt version
- Processing mode: Server, Cloud API, or Local
- Steps to reproduce and the expected behavior
- Relevant logs or screenshots, with secrets removed

## Local Development

### Client

Requirements: Node.js 18+, Rust 1.75+, CMake 3.20+, and the Vulkan SDK for local
ASR builds.

```bash
cd client
npm install
npm run tauri dev
```

### Server

Requirements: Python 3.10+ and an NVIDIA GPU with CUDA for GPU inference.

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cd backend
uvicorn app.main:app --port 8000
```

## Code and Documentation

- Keep TypeScript code compatible with the project's strict compiler settings.
- Keep user-facing documentation and code comments in English unless a specific
  translation is being added.
- Keep changes focused and update tests for new behavior.
- Do not include API keys, credentials, private URLs, or user data in commits.

Run the relevant tests and `npm run build` before opening a pull request. The
current `npm run lint` command requires the project's ESLint configuration to be
migrated to flat config or ESLint to be pinned to a legacy-compatible version.

## Commit Messages

Use conventional prefixes:

- `feat:` new functionality
- `fix:` bug fixes
- `refactor:` code restructuring
- `chore:` build, tooling, or dependency changes
- `docs:` documentation changes
- `perf:` performance improvements


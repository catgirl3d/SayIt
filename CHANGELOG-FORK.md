# SayIt (Fork Changelog)

This file records the meaningful changes maintained in the SayIt fork relative to upstream `crosswk/SayIt`.
The manual Windows release workflow embeds it into the GitHub Release notes for every build.

## Features and Improvements

### Speech Recognition

- Added Russian as a selectable recognition language in the client.
- Added Sber GigaAM as a Russian speech-recognition provider for the server, with configurable RNNT and CTC variants.
- Promoted existing Parakeet Unified English and Nemotron local ASR models into the default visible model list.
- Added persistent microphone input boost with 1x, 2x, 3x, 5x, and browser-managed automatic gain modes.
- Limited Groq's Chinese punctuation hint to explicitly selected Chinese, preventing it from being injected into automatic or other-language requests.

### AI Prompts and Localization

- Added English variants for built-in cleanup, translation, conversational, context-editing, provider, and application prompts.
- Added Ukrainian interface localization with manual switching and system-language auto-detection.
- Made English the default built-in prompt language when no saved choice or legacy Chinese override exists, while preserving existing prompt-language choices and legacy Chinese overrides.
- Moved shared prompt and rule definitions into reusable constants.

### Desktop Client

- Reworked settings into routed pages instead of one large settings dialog, including dedicated Audio & Mic and Shortcuts pages.
- Hardened startup initialization so configuration, locale, and provider failures do not block the main UI.

## Reliability and Build

- Added deployable GigaAM backend support, including dependency locks, container model provisioning, and ASR-engine selection.
- Updated the Vulkan SDK fallback to `1.4.357.0` for the GGUF/transcribe.cpp build.
- Added regression coverage for microphone boost and GigaAM recognition paths.
- Added a manual Windows release workflow that builds the current fork commit, replaces the current-version tag and Release, and publishes the NSIS installer.

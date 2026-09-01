# SayIt (Fork Changelog)

This file records the meaningful changes maintained in the SayIt fork relative to upstream `crosswk/SayIt`.
The manual Windows release workflow embeds it into the GitHub Release notes for every build.

## Features and Improvements

### Speech Recognition

- Added Russian as a selectable recognition language in the client.
- Added Ukrainian as a selectable recognition language in the client.
- Added Sber GigaAM as a Russian speech-recognition provider for the server, with configurable RNNT and CTC variants.
- Added selectable and downloadable local GGUF ASR options for GigaAM v3 e2e RNN-T and Whisper Small, Large v3 Turbo, and Large v2.
- Promoted existing Parakeet Unified English and Nemotron local ASR models into the default visible model list.
- Added one shared speech-input language setting for local, server, and cloud ASR, migrating legacy mode-specific settings and applying it to compatible recognition requests, history reprocessing, and built-in cleanup prompts.
- Added persistent microphone input boost with 1x, 2x, 3x, 5x, and browser-managed automatic gain modes.
- Limited Groq's Chinese punctuation hint to explicitly selected Chinese, preventing it from being injected into automatic or other-language requests.

### AI Prompts and Localization

- Added English variants for built-in cleanup, translation, conversational, context-editing, provider, and application prompts.
- Added Ukrainian built-in cleanup, translation, and conversational presets with per-language prompt overrides.
- Added English, Ukrainian, and Russian translation target presets and made the English translation preset language-agnostic.
- Added Ukrainian interface localization with manual switching and system-language auto-detection.
- Made English the default built-in prompt language when no saved choice or legacy Chinese override exists, while preserving existing prompt-language choices and legacy Chinese overrides.
- Moved shared prompt and rule definitions into reusable constants.

### AI Providers

- Added remote model discovery for Ollama and OpenAI-compatible endpoints, with selectable model catalogs in the settings UI.

### Desktop Client

- Reworked settings into routed pages instead of one large settings dialog, including dedicated Audio & Mic and Shortcuts pages.
- Hardened startup initialization so configuration, locale, and provider failures do not block the main UI.

### Support and Diagnostics

- Replaced the desktop-client feedback flow with direct GitHub Issue reporting for the fork, using shared repository links and a public bug-report template.
- Added local allowlist-based public-safe diagnostics bundles for preview, manual review, and attachment to GitHub Issues; exports contain structured environment, summary, and event data rather than raw logs, transcripts, screenshots, or user-entered descriptions.

## Reliability and Build

- Added deployable GigaAM backend support, including dependency locks, container model provisioning, and ASR-engine selection.
- Updated the Vulkan SDK fallback to `1.4.357.0` for the GGUF/transcribe.cpp build.
- Added regression coverage for microphone boost and GigaAM recognition paths.
- Added a manual Windows release workflow that validates and embeds `CHANGELOG-FORK.md`, builds the dispatched fork commit, recreates the current-version tag and Release, and publishes the NSIS installer with bounded Cargo parallelism.

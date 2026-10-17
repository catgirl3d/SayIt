# SayIt Changelog

Release history and notable changes for the SayIt fork.
Sections are ordered by version, newest first.

## v0.3.1 (unreleased)

### Changed
#### Desktop Client
- Scrollbars in the main window are now thin and follow the theme everywhere: dialogs, lists, and text fields no longer fall back to the browser's light default scrollbar. The overlay's recognized-text and error cards get a matching dark scrollbar when their text is long.
- The configuration export and import dialogs now behave like every other dialog: focus moves into them and returns when they close, Tab stays inside, and all dialogs share the same frosted theme-tinted backdrop instead of a mix of black and blurred variants.
- The focus highlight is now clean and themed: text fields get the accent border with a soft halo, and other controls a single accent ring, instead of the browser's doubled blue-and-white outline.

### Fixed
#### Desktop Client
- Dialogs no longer close when you select text in a field and release the mouse outside the dialog. Before, such a drag closed the dialog and discarded what you had typed.
- With two dialogs open at once, such as the backup list under a restore confirmation, Esc now closes only the top one.
- A long dialog title no longer runs under the close button.

## v0.3.0 — 2026-10-17

### Added
#### File Transcription
- The Files page now keeps its own transcription setup instead of mirroring the global voice mode: choose the local model (from installed ones), the recognition language for both local and cloud jobs, and Local or Cloud right on the page. The page remembers the last used setup across restarts, and none of these choices change the global dictation settings.
- Added a Files page that transcribes an audio or video file into TXT and Markdown with the local speech engine. Pick the file and, when a video has several, its audio track; the result is saved next to the file or in a folder you choose. You can follow progress, cancel, and retry a failed export. The recognized text stays in a draft that survives cancel, errors, or a crash, and it is never typed into the active window.
- The Files page can also transcribe through a configured Cloud API profile: switch the engine to Cloud in the settings panel and pick the profile. An incompletely configured profile keeps Start off and names what is missing, and cloud jobs leave the local engine free — local dictation and computer subtitles keep working.
- SayIt ships a bundled FFmpeg and FFprobe pair, so file transcription works out of the box with no manual install and no PATH setup; a different FFmpeg folder can still be selected on the Files page.
- While a file job runs, starting local dictation or local computer subtitles is refused with a busy notice instead of sharing the same engine; a file job will not start while either is active, and cloud modes keep working. File jobs never enter History or usage statistics.

#### Computer Subtitles
- Computer subtitles can keep a text journal of a session: turn it on in the Saving subtitles dialog, and each recognized fragment is appended to a text file, the original followed by its translation or "(no translation)". Each session gets its own file, named after its start time, in Documents/SayIt/Subtitles or a folder you choose. Speech still awaiting translation at stop is written too. If the file can no longer be written, the journal says so once and stops, while subtitles keep running.

#### Hotwords
- Added nine built-in hotword categories next to AI terms, each a compact set of English terms that speech recognition tends to get wrong: Programming, AI coding & agents, Cloud & DevOps, Data & ML, Product & management, Design & UI, Business & marketing, Office & meetings, and Creative & streaming. They are off by default; turn on the ones you need in Hotwords.
- Hotwords shows an approximate budget for the active list, such as "Budget: ~215 / 500 tokens · 84 / 100 words", with a bar that turns amber near the limit and red over it. A category that would push the list past 500 tokens cannot be turned on: Deepgram rejects longer keyterm lists, and SayIt would then send none. Above 100 words, a note warns that Gemini and the Qwen audio stream use only the first 100. Turning categories off and typing your own terms are never blocked, but they still count toward the budget.
- Your own categories can be built from the built-in ones: "From suggestions" on a category card lists the terms of every built-in category, with tabs and a search, and a click adds or removes a term. Copy turns a built-in category into your own, which replaces the original (switched off) and can be trimmed to the terms you need. Terms and copies that would exceed the token budget are unavailable.

#### Usage Statistics and Data Safety
- Before database schema upgrades, SayIt creates a verified standalone SQLite backup beside the database. Backup failure stops the upgrade; existing copies are never overwritten or automatically deleted.

#### Desktop Client
- Added a Help button to the Voice engine and AI providers pages: a short guide to choosing a recognition mode and a cloud service, with direct links to the pages that issue API keys. Groq (generous free tier, one key for recognition and AI cleanup) and Deepgram ($200 free credit, strong live captions) are marked as recommended and listed first; each explains why, and Groq also suggests models.
- The About page shows release notes in the interface language: a release can carry a Ukrainian translation of its changelog section ([CHANGELOG.uk.md](CHANGELOG.uk.md)), and the app falls back to English when none exists. Releases published earlier keep their English notes.

### Changed
#### Computer Subtitles
- The live original in Computer subtitles is now compact for a short phrase and grows up to three lines with the text, instead of occupying a fixed-height card.
- In live computer-audio subtitles, the original panel no longer blanks out between phrases: the last recognized phrase stays on screen while its translation is prepared, until the next phrase replaces it. It clears only when the session pauses or stops.
- Translations in Computer subtitles now settle once as a whole instead of being repainted while the AI is still writing, so the caption card no longer collapses to a short line and jumps back at every phrase.
- The Live computer-audio recognition setting is now shown only while Deepgram is the active Cloud API speech service. With any other engine the setting is hidden and its explanation is not offered, since live recognition is not available there; the saved preference is kept and reappears when Deepgram is active again.
- Reorganized the Computer subtitles page around one session bar: the output device, the audio and translation languages, and Start sit in a single row. While subtitles run, the bar shows the status, Pause/Resume and Stop, and a locked summary of the device and languages, with live captions below. Captions, Saving subtitles, and Diagnostics are now rows that show their state on one line, such as "Up to 6s · original above translation · live recognition", and open their settings on click, so live recognition, which sends audio to Deepgram, is visible at a glance. A running session is also marked by a dot in the sidebar, and the page notes moved behind a Help button.
- Computer subtitle translation now gets up to 500 characters of preceding speech from the last six fragments as context (was 300 characters from two).
- Live computer-audio captions end at sentence ends much more often. A caption that has reached half of its maximum length closes at a recognized sentence end as soon as the next sentence begins. A caption cut by the length limit ends at its last sentence end or punctuation mark and avoids ending on a dangling word such as an article, preposition, or number (English, Ukrainian, Russian); the rest opens the next caption. A cut in mid-speech waits briefly for a pause, so the word at the boundary is far less often duplicated, split, or lost.
- Live captions can now take three lines for the translation and for the original above it before they are cut with an ellipsis (was two), except while both a notice and a warning are shown, when they keep two lines.

#### Speech Recognition and Models
- New installs use Nemotron Streaming 0.6B as the default local model, which recognizes Ukrainian and Russian out of the box; SenseVoice stays available as the fastest Chinese/English option.

#### AI Cleanup and Editing
- AI cleanup failures are no longer silent: when the selected provider does not respond, returns an error or an empty result, or its profile is incomplete, the overlay shows a short reason notice after the recognized text is inserted, and History marks the record as "AI: not applied" instead of hiding the AI row.

#### Usage Statistics and Data Safety
- Usage statistics now count successful dictations independently of history, without storing text, audio, or window titles, and with times rounded to 15 minutes. They work with history saving off, no longer drop when history is cleared, and are no longer capped at 10,000 records. Home and Usage share the same totals and refresh live. Clearing statistics also resets personalization. Upgrades keep existing totals and per-app profiles, and full backups, including WebDAV, include the usage log.

#### Desktop Client
- Microphone boost on the Audio page now has a Manual / Auto switch and, in Manual, a slider for any gain from 1× to 20× in 0.5× steps instead of only 1×, 2×, 3×, and 5×, with chips for common values. The slider is logarithmic, so the everyday 1×–5× range is no longer squeezed, and it shows the gain in decibels and whether it is safe, high, or at risk of distortion. It works from the keyboard, and saved settings keep their gain.

### Fixed
#### Computer Subtitles
- Live computer-audio captions no longer flicker by replacing the beginning of a phrase with its end: each piece of speech now settles as one whole caption once the recognition service confirms it, a fraction of a second later. Long speech is still divided by the caption length setting, but each piece appears whole; a lost service answer still settles the confirmed text.
- Live computer-audio recognition no longer stops with "Live recognition stopped because source audio timing exceeded the retained capture window" when the captured audio has many small timing irregularities while a phrase is spoken.

#### Hotwords
- Removing a term with its ✕ now removes it only from the category where you clicked it. Before, it was removed from every category and built-in set at once.
- Removed the Chinese words from the built-in AI hotword set; saved copies drop them on the next load.

#### Speech Recognition and Models
- Local model selection is consistent now: an empty saved model setting means the default local model instead of blocking dictation, and the engine indicator resolves built-in model names without the model catalog, which is only consulted for models outside the built-in list.
- The automatic paragraph splitting and number normalization switches are now shown only when the speech language is Chinese; for other speech languages they did nothing and are hidden.
- Qwen realtime streaming now sends the selected speech language instead of always assuming Chinese; with "auto" the service identifies the language itself.

#### AI Cleanup and Editing
- Selection editing no longer defaults an unspecified "translate" command to Chinese: Ukrainian selected text is translated to English, and any other text to Ukrainian.

#### Desktop Client
- Fixed overlay toast and error notices being truncated when messages exceed recording waveform preset widths: the overlay window now expands up to 600px for toast and single-line error cards while preserving the dynamic, centered pill layout, and overflowing text falls back to an ellipsis.
- In dark themes, floating panels — help tooltips, dropdown lists, and the model language popover — are now drawn on a darker surface than the cards and page behind them, so they no longer blend into the background. Light themes are unchanged.
- The built-in text replacements no longer carry Chinese-only defaults or the pump→Prompt rule; new installs keep only the Cloud Code → Claude Code correction.

## v0.2.2 — 2026-10-12

### Features and Improvements

#### System-Audio Translation Subtitles

- Added a Windows computer-audio subtitle mode using native WASAPI loopback, without a virtual audio cable or browser extension. Select an output device and translate short speech fragments into Russian, Ukrainian, or English in a persistent, click-through overlay.
- Added a separate subtitle source-audio language setting, defaulting to Auto and independent of microphone dictation language.
- Reuses the configured local, cloud API, or server speech engine and existing AI provider. Subtitle translation is independent of the dictation cleanup switch; fully local operation requires both local ASR and a local AI endpoint. Audio from other applications and notifications on the selected output device is included.
- Start, pause, resume, and stop controls are available under Computer subtitles. Microphone dictation resumes after stopping this mode. Capture and device interruptions are shown explicitly and still require recovery.
- Stop and pause wait for the current cleanup to finish instead of starting overlapping retries after a timeout. A delay is reported without allowing a new session to reuse resources that are still stopping; a completed, failed operation can be retried. The live-recognition switch stays disabled while its saved value loads or a setting write is pending.
- Saving the live-recognition setting no longer clears an unresolved page-loading error; a failed setting write keeps its own error visible until a later write succeeds.
- Brief recoverable audio gaps discard unfinished speech and reset voice-detection context without stopping the subtitle session. A warning identifies the gap; device failures still require recovery.
- A single failing fragment no longer stops Computer subtitles. When translation fails or returns the speech unchanged (already in the target language, a name, a number), the recognized original is shown unchanged, with an "Original text: this fragment was not translated" notice in the overlay status line, and a fragment whose recognition fails or stalls for 30 seconds is skipped with a notice. The session stops with the real error only after three fragments fail in a row; a successful fragment restarts that count.
- When processing falls behind playback, the oldest waiting speech is dropped with a notice and listening continues, instead of stopping capture. The backlog stays bounded at about 12 seconds of audio.
- Improved the opt-in Computer subtitles pipeline debug panel with a live current-stage indicator, successful-run averages plus ASR and latency p90/max timings, mode/status filters, slow queue and latency highlighting, and TSV copy of filtered summaries and runs. The panel now also shows why each speech segment was cut (end of speech, pause, length limit, audio stopped, or cut mid-speech), per-reason counts, and the longest delay between received frames during speech, so subtitle segmentation can be tuned from data instead of guesses.
- Computer subtitles no longer cut speech mid-word. After a minimum length the first short pause closes a segment, and continuous speech that reaches the length cap is cut at its quietest point, with the audio after the cut carried into the next segment instead of being severed on an arbitrary frame. A new Maximum caption length slider sets how much speech one caption may cover, from 3 to 6 seconds in 0.5 s steps (default 6 s, the previous fixed limit); pause splitting starts at two thirds of the chosen limit, and the setting applies from the next start.
- Computer subtitle translation now uses its own short live-subtitle prompt instead of the dictation translate presets, which are still used only to list the available target languages. The prompt tells the model that each fragment can start or end mid-sentence and must not be completed or invented. Editing a built-in translate preset therefore no longer changes subtitle translation.
- Each subtitle fragment is translated with up to 300 characters of the speech recognized just before it as read-only context, so pronouns, names, and terms stay consistent across fragments. Context is dropped after a pause of more than 6 seconds and when the session stops or resumes. It is not sent to a managed server AI that does not advertise `text_context` support.
- Added an opt-in dual-subtitle mode for Computer subtitles ("Show original and translation"). The recognized original appears in a smaller muted line above the translation as soon as it is recognized, while the translation is still being produced, and both clear together. When a fragment is shown untranslated it appears once, as the main caption. The setting applies from the next start and is ignored in recognition-only mode.
- The Computer subtitles overlay no longer prints the constant "Listening to computer audio" label above the captions, and draws nothing at all while nobody is speaking. The status line still appears for startup, pause, stop and error states, and for warnings and untranslated notices.
- Added an opt-in recognition-only test mode for Computer subtitles that shows raw ASR output without translation (the target language is ignored), for measuring and comparing speech engines.
- Increased the loopback capture buffer reserve to 200 ms to prevent brief voice-detection and event-delivery stalls from losing speech. Available audio is still read immediately; capture does not wait for the buffer to fill.
- Computer subtitles now overlap recognition and translation in client-AI modes (cloud API, local, and custom-AI server): the next fragment is recognized while the previous one is still being translated, so captions keep up with live speech much longer instead of waiting for the full ASR-plus-translation chain per fragment. Managed-server runs keep a single ASR-plus-translation run. Translations that fall behind are dropped oldest-first with the same "processing is behind playback" notice as the audio backlog, so captions never drift far behind.
- Live subtitles now show the translation while the AI is still writing it: client-AI modes stream the model output and repaint the caption as it grows, so the first words appear within a fraction of a second instead of waiting for the whole answer. The settled translation still replaces the partial text, and providers that do not stream keep the previous behavior.
- Added opt-in live recognition for Computer subtitles with Deepgram in Cloud API mode. Supported live sessions send computer audio continuously, including silence and background sound, to Deepgram Cloud, which may increase usage; unsupported profiles retain batch recognition. The selected caption length is a target, not a hard cap while live recognition finishes.
- Live originals are shown separately from settled captions, and only confirmed phrases enter translation. Network errors are surfaced instead of silently replaying sent audio through a billed batch request; a capture discontinuity starts a fresh live stream and can lose unfinished speech during recovery.

#### Speech Recognition

- Replaced the hardcoded hotword support table with a Rust capability matrix tied to ASR dispatch, including provider-specific delivery, client limits, and unsupported paths.
- Added `whisper-large-v3` as a direct Groq ASR model choice; `whisper-large-v3-turbo` remains the default.
- Fixed history records being labeled with whichever ASR profile was active when the entry was written: a completed recording now keeps the provider and model that actually recognized it, even if the active profile was switched while recognition was still running. History reprocessing writes the same snapshot-backed metadata.
- Cleared outdated ASR test verdicts when a saved profile's model is no longer current: profiles migrated or imported from an older catalog no longer show a green "available" result measured against a model they no longer use.
- Updated the built-in Qwen Audio streaming ASR model to `qwen-audio-3.1-asr-flash-streaming`.
- Added Deepgram Nova-3 as a cloud ASR profile with live streaming captions over WebSocket, including Russian, Ukrainian, English and Chinese language selection and a settings connection test. It needs a Deepgram API key from an international account.
- Added opt-in Deepgram dictionary hints per ASR profile for batch and live recognition, with explicit pricing and 500-token limit disclosure. An explicit limit rejection gets one retry without hints; dictation shows a short "no hints" toast while the full notice appears on recovery cards and in Computer subtitles and History reprocessing, and the Dictionary support table marks hints as active only when the profile enables them. Recognized text, the saved dictionary, and the profile setting are preserved.
- Deepgram now sends completed recordings and Computer subtitle segments through its prerecorded HTTP endpoint, avoiding the extra streaming connection and recognition delay of uploading a complete clip through WebSocket. Live dictation captions continue to use WebSocket.
- The built-in recognition test and its playback in Settings now use a clip matching the selected speech language (Russian, Ukrainian, English, Chinese; English for Auto) instead of always the Chinese clip, so a working engine can no longer look broken because the test audio was in a language it does not recognize. Added bundled Russian and Ukrainian test clips; the language-mismatch warnings are gone.
- Added Russian as a selectable recognition language in the client.
- Added Ukrainian as a selectable recognition language in the client.
- Added Sber GigaAM as a Russian speech-recognition provider for the server, with configurable RNNT and CTC variants.
- Treat empty Qwen Omni results after a premature WebSocket close or stream end as errors; nonempty partial transcripts remain successful.
- Added selectable and downloadable local GGUF ASR options for GigaAM v3 e2e RNN-T and Whisper Small, Large v3 Turbo, and Large v2.
- Promoted existing Parakeet Unified English and Nemotron local ASR models into the default visible model list.
- Added one shared speech-input language setting for local, server, and cloud ASR, migrating legacy mode-specific settings and applying it to compatible recognition requests, history reprocessing, and built-in cleanup prompts.
- Added persistent microphone input boost with 1x, 2x, 3x, 5x, and browser-managed automatic gain modes.
- Replaced computer-subtitle device and language dropdowns with the shared selectors and localized saved output devices that are no longer listed.
- Save computer-subtitle device and translation-language choices immediately; use the interface language as the default translation target instead of hardcoded Russian.
- Limited Groq's Chinese punctuation hint to explicitly selected Chinese, preventing it from being injected into automatic or other-language requests.
- Added buffered OpenAI, Gemini, and OpenRouter transcription profiles with per-profile model selection and language-aware requests.
- Added per-profile OpenAI-compatible ASR endpoints for multipart transcriptions and chat input_audio, with optional local-service keys and opt-in Auto fallback only on an explicit structured route-mismatch response. Auto can incur a charge on its first request; new profiles default to one transcriptions request.
- Added Qwen 3.8 Omni Flash Realtime as a selectable buffered recognition and cleanup profile; live captions are not provided by this route.
- Show per-model language badges in the local model list indicating whether each model supports your language (selected speech language, or interface language when speech is set to Auto).
- Added interactive language badges and popover dialogs to the local model catalog: users can inspect full localized language lists with instant search, see active speech-language compatibility pills, and clearly distinguish supported languages across all multilingual models (Parakeet, Nemotron, Qwen3, Whisper, SenseVoice).
- Improved language badge popover accessibility and viewport positioning, including keyboard focus handling, close labels, scroll/resize alignment, tooltip suppression, and empty-metadata separators.
- Corrected the local model catalog's language support matrix to match upstream model cards (Nemotron 3.5 ASR: 40 locales across three quality tiers; Qwen3-ASR: 30 languages; Whisper: 100 languages), fixing false "unsupported language" badges for languages the models actually recognize, such as Ukrainian and Russian on Nemotron and Russian on Qwen3-ASR.
- Added five upstream GGUF local ASR models: Parakeet TDT v3 (25 European languages, 1.94% LibriSpeech WER), Fun-ASR MLT Nano (31 languages, 1.74% LibriSpeech WER), Parakeet TDT 1.1B (English, 1.38% LibriSpeech WER), GigaAM v3 CTC (compact Russian), and Whisper Large v3 (100 languages, 1.86% LibriSpeech WER).
- Removed Whisper Large v2 from the local model catalog in favor of Whisper Large v3 and v3 Turbo, which match or exceed its accuracy with lower memory use and faster transcription. Existing selections of v2 keep working, and previously downloaded v2 weights are not deleted.
- Redesigned the local model catalog cards with consistent micro-chips for disk, memory, quantization, and languages, eliminating layout shift and uneven button alignment.
- Added model catalog filtering with "All" and "Downloaded" tabs and a quick search bar with instant cross-lingual search across localized model titles, descriptions, quantization tiers, and language names (Ukrainian, Russian, English).
- Made downloaded model cards selectable by clicking anywhere on the card body (with keyboard navigation via Enter and Space), removed redundant explicit select buttons, and highlighted the model delete action with a clear soft-destructive style.
- Saving or deleting a speech-recognition card now reports a failed write instead of leaving the confirmation dialog open and doing nothing: the deletion stays unconfirmed, and the error appears on the page or inside the editor with the draft intact. A test whose result could not be saved (single card or batch) now reports the save failure instead of claiming the test never ran.

#### AI Prompts and Localization

- Added English variants for built-in cleanup, translation, conversational, context-editing, provider, and application prompts.
- Added Ukrainian built-in cleanup, translation, and conversational presets with per-language prompt overrides.
- Added English, Ukrainian, and Russian translation target presets and made the English translation preset language-agnostic.
- Added Ukrainian interface localization with manual switching and system-language auto-detection.
- Removed the Simplified Chinese desktop, tray, overlay, web-demo, and installer UI; English and Ukrainian are now the only supported interface locales while Chinese ASR remains supported independently.
- Removed the Chinese built-in prompt option. Legacy Chinese prompt records may remain stored for safe parsing, but Chinese prompt selection and active legacy Chinese overrides are no longer supported; English and Ukrainian instructions remain available with per-language prompt overrides.
- Moved shared prompt and rule definitions into reusable constants.
- Reworked the Ukrainian interface copy throughout the app: settled terminology (застосунок, папка, налаштування, провайдер, AI-очищення, Копіювати, Закрити), clearer wording and grammar, number-in-message templates that no longer produce broken forms like "1 термінів", and unified punctuation — the single ellipsis character "…" now replaces "..." in both English and Ukrainian strings.

#### AI Providers

- Fixed History reprocessing to run keyless Ollama, preserve raw ASR after failed or blank cleanup, and write or clear AI attribution from the configuration and outcome actually used.
- Added remote model discovery for Ollama and OpenAI-compatible endpoints, with selectable model catalogs in the settings UI.
- Added OpenCode Go as an AI provider preset and send the mandatory `x-opencode-session` routing header on OpenCode (Zen and Go) endpoints, fixing HTTP 400 `MissingSessionID` failures.
- Decoupled connection testing from configuration saving in the AI provider editor modal: added an in-modal "Test connection" action for real-time verification without saving or closing, alongside standard Cancel and Save actions that properly close the modal on completion.
- Stopped the AI provider editor from pre-filling a new service with the active profile's URL and key: the New dialog now starts from the selected provider's own defaults with an empty key, while switching to an already configured provider still reuses its saved credentials with an explicit note.
- Fixed the AI provider editor keeping another provider's URL and key in the form when the provider select was switched back and forth; values the user typed are still preserved.
- Added an OpenAI provider preset whose endpoint can be overridden per profile for local proxies and relays, plus Reasoning effort control for OpenCode Go (both verified against the live APIs). The optional Reasoning effort and Service tier settings are sent only by the presets whose endpoints accept them — generic OpenAI-compatible endpoints keep receiving the unchanged request body — and the offered levels follow the current OpenAI API (reasoning effort is model-dependent; `fast` opts into Fast mode).
- Activating or deleting an AI service card now reports a failed save instead of silently doing nothing, and the card list keeps matching what was actually stored: a failed write no longer leaves the broken selection highlighted or hides the error. A single-card connection test whose verdict cannot be saved reports the save failure too, instead of leaving the card spinning with the page stuck busy. Overlapping saves are now serialized, so the list of one save can no longer be paired with the active selection of another.
- AI service changes now save the profile list, active selection, and runtime settings in one database transaction, so a failed database write cannot leave one profile's URL or model paired with another profile's key. Other profile writes stay blocked until deletion and any error reconciliation finish, preventing deleted cards from returning after a quick activation. Deletion errors no longer claim that the card was kept when the save outcome could not be confirmed.

#### Desktop Client

- Profile cards in Settings no longer react to clicks on the test, edit, and delete buttons while those buttons are hidden until hover; keyboard focus still reveals and reaches them.
- Added an optional setting to prevent automatic insertion of ASR results received after processing times out. During the existing 15-second grace period, late results are saved to History when possible, otherwise discarded; they do not update personalization statistics. The default remains automatic insertion.
- Cleaned up the microphone picker: hide duplicate browser-default entries, label the communications route with its target device instead of the raw Chromium name, hide it when it resolves to the same device as System default (kept when saved or distinct), and show the last-enumerated physical device match for System default when unambiguous; stored selections and recording behavior are unchanged.
- Added concise, dismissible recognition failure cards with safe localized causes and a History retry hint only when the saved recording is actually available.
- Reworked settings into routed pages instead of one large settings dialog, including dedicated Audio & Mic and Shortcuts pages.
- Added an accessible microphone selector label with the full device name on hover; local formatting controls are disabled while AI cleanup is enabled without resetting saved options.
- Hardened startup initialization so configuration, locale, and provider failures do not block the main UI.
- Added F13-F24 single-key shortcut support for programmable keyboards and remapping tools.
- Prevented single-key nonmodifier shortcuts from activating while Ctrl, Alt, Shift, or Win is held in both the native hook and focused-app WebView fallback.
- Recognize `Weixin.exe` (WeChat 4.x) in the existing editability allowlist without generally allowing Qt windows.
- Fixed the home screen and setup guide showing a blank keycap when the hands-free hotkey had been cleared: they now fall back to the bound push-to-talk key with hold-to-talk wording, and state explicitly when no dictation hotkey is configured.
- Record usage statistics for completed dictations when history retention is disabled, applying the increment atomically in the native store and refreshing the home screen live; recordings without text no longer add dictation time in either history mode. Time already accumulated by older no-text entries stays in the totals and is not recalculated when those entries are deleted.
- Added a confirmation-protected action to clear home-screen usage totals without deleting history or audio recordings.
- Added a confirmation-protected "Clear history" action on the History page that deletes every record (starred ones included) together with its saved audio recordings, and subtracts the deleted records from the home-screen usage totals.
- Corrected equivalent typing-time estimates to use 50 words per minute (250 standardized characters per minute) instead of 50 characters per minute, and show seconds for short Home statistics.
- Updates are now fork-only and consent-based: SayIt checks this fork's own GitHub releases for new versions, and a version is downloaded and installed only when you press "Download and install" — closing the app never installs anything. A "Check for updates automatically" switch was added to General settings, and the About page now shows a fork build marker.
- The About page now shows the real release notes of the latest released version, and of an available update before installing it: the notes travel inside the update manifest, straight from the fork changelog. The hand-written highlight list and its translations are gone.

#### Support and Diagnostics

- Replaced the desktop-client feedback flow with direct GitHub Issue reporting for the fork, using shared repository links and a public bug-report template.
- Added local allowlist-based public-safe diagnostics bundles for preview, manual review, and attachment to GitHub Issues; exports contain structured environment, summary, and event data rather than raw logs, transcripts, screenshots, or user-entered descriptions.

### Reliability and Build

- Added deployable GigaAM backend support, including dependency locks, container model provisioning, and ASR-engine selection.
- Updated the Vulkan SDK fallback to `1.4.357.0` for the GGUF/transcribe.cpp build.
- Added regression coverage for microphone boost and GigaAM recognition paths.
- Added a manual Windows release workflow that builds the dispatched fork commit, recreates the current-version tag and Release with the released version's changelog section as the release notes, and publishes the NSIS installer with bounded Cargo parallelism.

# Upstream port tracker

Progress list for porting upstream `crosswk/SayIt` features into this fork.
Covers upstream 0.2.1 (`8687e9b`), 0.2.2 (`c704300`) and the selected 0.2.3 ports tracked in #53, plus follow-up fixes.

- Detailed per-topic analysis lives in the git-ignored `dev-scripts/upstream-slices/` folder.
- The local `dev-scripts/upstream-decisions/` journal remains the authoritative record for accept/reject decisions on upstream commits; this file mirrors progress in one readable list.
- Update this file when a port lands or a decision changes. Keep one row per feature.

Last updated: 2026-10-27: the full upstream `85c9e69` binary-IPC port is declined in #53 (see Won't do), and Blob playback is declined as well; the base64 cost is removed by the native `Uint8Array.toBase64` encoder (#87, merged via PR #88 as `3c387c5`), while the outcomes that mattered are covered by #84 and #86. The shipped #53 items and follow-ups are mirrored in Ported and Fork follow-ups. Earlier 2026-10-25: #53 items 7a/7b, 12a and 12c declined, see Won't do; the local-mode timeout (7c) and keyboard hook recovery (12b) from the same upstream commits stay open in #53. Earlier the same day: AI-off settings hints ported from upstream `1adfeb2`, #53 item 14; fork `93741f3` and `72b5044`, PR #67 merged as `915b0ec`. Earlier 2026-10-24: Ditto clipboard-history exclusion ported from `c813028`, #53 item 9, fork `e581d6a`. Earlier 2026-10-18: History AI policy unified with the live route, #33; journal decisions recorded: `8687e9b`/`c704300` partial/adapted, `9158443` and PR #78 `0ceba3e` rejected — no pending upstream commits. PR ports are final, no re-porting planned: #87 → fork PR #22 and #85 → fork PR #25 (both merged); #86 declined; #83 not ported; server reasoning config and a separate chat-audio route also declined; all four upstream PR heads are kept on local `pr/*` branches).

## Ported

| Feature | Fork commit |
| --- | --- |
| Buffered OpenAI, Gemini, OpenRouter ASR profiles | `a68104e`, `26d7add`, `e65cf5e` |
| Per-profile OpenAI-compatible endpoints (`transcriptions` / `chat`, opt-in Auto fallback) | `455ebc6` |
| Groq `whisper-large-v3` choice (turbo stays default) | `431d1d9` |
| Qwen Audio 3.1; Qwen Omni 3.8 WebSocket (buffered, no live captions) | `20d21d2`, `37211c3`, `6e5d5c4` |
| Weixin.exe editability allowlist | `6d5fe4b` |
| Runtime single-key modifier guard (native hook + webview fallback) | `509efa4` |
| Dismissible recognition failure cards (recognition / timeout / empty; failed recordings kept in History) | `1c87702` |
| ASR provenance bound to the request profile in History | `5bf02c8` |
| History/AI polish fixes: blank completion is an error, keyless providers via catalog, request-time attribution, blank keyed model guard; reprocessing now shares the live AI route and cleanup executor (#33) | `6a5bfc5` |
| Settings accessibility and AI state fixes | `2ad1715` |
| Hotword capability matrix (Rust) + dynamic Dictionary support table + ignored-hotword diagnostics | `df2ef41` |
| OpenRouter AI cleanup provider preset (upstream PR #87, via fork PR #22) | `f6275b9`, `3cef9c2` |
| Selected-text editing model override (upstream PR #85, via fork PR #25) | `1f5d99b`, `0baee8f` |
| Ditto clipboard-history exclusion via `Clipboard Viewer Ignore` (upstream `c813028`, #53 item 9) | `e581d6a` |
| AI-off settings hints: dim AI-dependent controls, preserve saved choices, explain the server-managed selected-text exception (upstream `1adfeb2`, #53 item 14) | `93741f3`, `72b5044` (PR #67) |
| Upstream `c405ccd` client hardening subset: audio path guard, CSP/capabilities, backup import, file IPC path checks, HTTPS validation | `cdb0267`, `4000c58`, `9900af5`, `4b8359c`, `d0b688b` |
| Server hardening: static-path traversal, request body limits, CORS and error responses (upstream `524d807`) | `57a9376`, `0323708`, `f93cd02` |
| Qwen Omni long recordings: Qwen-only rate fix (upstream `a1aef44`) | `1282817` |
| Hotkey start lock released after a preparation failure (upstream `7c694e8`, #53 item 8) | `44e98e8` |
| History and favorites grouped by local day (upstream `6fe07be`, #53 item 11) | `f896796` |
| History reprocess failure reason (upstream `552e881`, #53 item 10) | `dad27da` |
| Resumable update download (upstream `3710ff9` subset, #53 item 13) | `cbe5211` |

## Fork follow-ups

| Feature | Fork commit |
| --- | --- |
| History reprocessing reads raw PCM with RIFF validation (#53 follow-up, PR #84) | `711d32f` |
| History recordings copied directly to Downloads in Rust (#53 follow-up, PR #86) | `ed51441` |
| Native `Uint8Array.toBase64` audio encoder (chosen alternative to `85c9e69`, #87, PR #88) | `3c387c5` |

## Partial

| Feature | What is missing |
| --- | --- |
| Qwen models | Qwen Audio 3.0 selectable fallback; Omni HTTP/chat profile; legacy Omni alias migration for old profiles |
| Microphones | Picker-only cleanup in `e0b376e`: duplicate default/identical IDs hidden, communications route labelled and hidden when redundant with the system default (kept when saved or targeting another device), saved routes preserved, last-listed default device shown only on an unambiguous match (not a live route guarantee). Recorder overlay label parity is unassessed; saved-ID migration is deliberately out of scope. |
| Late ASR result | Opt-in suppression shipped in `02866a8` (+ `5faade0`): within the existing 15 s grace, no automatic insertion; History saves when enabled and successful, otherwise the text is discarded. Suppressed results do not update personalization statistics. Upstream per-run Esc abandonment remains unported. |
| Recorder failure lifecycle | Cards done; upstream stuck-insertion watchdog intentionally skipped so far |
| Overlay live captions | Unconfirmed flicker risk when warning payloads lack `streaming`; verify visually before treating as a bug |
| Updater card | Consent-based updater has no downloaded-waiting state; needs design before any port |
| Documentation | README does not list all cloud ASR providers; hotword docs stay generic |

## Upstream PR watch

Checked 2026-10-27: upstream 0.2.3 is released as `f2d2921` (2026-10-19). The four @DemonMartin PRs are closed without merge: #85 and #87 were rewritten upstream (`def0c6e`, `9d3165a`), while #83 and #86 were not implemented. All four heads remain on local `pr/83`–`pr/87`. Fork ports are final: no re-porting if upstream later merges (see Ported and Won't do).

| Upstream PR | Feature | Fork decision |
| --- | --- | --- |
| #83 | Recognition fallback chains (local/cloud/server) | Not ported; commits kept on `pr/83`. High resilience win, no Rust; wide recorder/timing refactor (timeout 30→60 s) — adapt carefully if taken. |
| #85 | Selected-text editing model override | Ported via fork PR #25 (`1f5d99b`, `0baee8f`); upstream rewrite `def0c6e` adds nothing (`already-present`). |
| #86 | Contributors list on About | Declined: hardcodes the upstream repo/API, no functional value. |
| #87 | OpenRouter AI cleanup preset | Ported via fork PR #22 (`f6275b9`, `3cef9c2`); upstream rewrite `9d3165a` adds nothing (`already-present`). |

## Deferred

| Feature | Reason |
| --- | --- |
| GPU device selection | Deferred 2026-10-02: only useful with 2+ GPUs, selector hidden on single-GPU machines, no live validation possible here; upstream patch and crate support are ready when needed |
| Paste effect verification | Deferred 2026-10-04 by choice. `WM_PASTE` reports message delivery, not observed text insertion; do not port upstream retries without separate approval and Windows evidence. |
| OpenAI Realtime / Gemini Live | Not validated with a real key; keep buffered routes |
| Recorder split (upstream `72b2ee8`) | Deferred: large refactor of the recorder orchestrator, no user-visible need now |
| Dependency cleanup (upstream `c274583`) | Deferred: no user-visible benefit now |

## Won't do

| Feature | Decision |
| --- | --- |
| Zhipu/GLM preset and forced GLM thinking | Reachable manually via OpenAI-compatible; forced reasoning rejected as risky for all providers |
| ASR catalog redesign / one-card-per-platform UI | Fork keeps its service-profile model (deliberate UX choice) |
| Upstream release metadata (versions, changelogs, highlights files) | Fork owns versioning and release tooling |
| Upstream-only docs and assets (community links, Chinese README images) | No functional value for the fork |
| Standard `input_audio` chat protocol (PR #78, `0ceba3e`) | Already the fork's only custom chat format (`455ebc6`); the DashScope data-URL chat variant stays out — Qwen/DashScope goes through the native Qwen providers |
| GitHub contributors list on About (PR #86) | Declined: hardcodes the upstream repo/API, no functional value; not planned even if merged upstream |
| Server reasoning config (skip temperature / `reasoning_effort`) | Declined 2026-10-17: server AI keeps its fixed temperature; no reasoning settings are exposed |
| OpenAI Chat Audio as a separate route (distinct from the custom OpenAI-compatible `chat` protocol) | Declined 2026-10-17: the per-profile `chat` protocol and the native Qwen providers cover this path |
| Local ASR: split long recordings at pauses and fall back to CPU after a GPU error (upstream `97bf4e1`, #53 items 7a/7b) | Declined 2026-10-25: guards against an integrated-GPU driver reset (TDR) nobody has observed in logs or reports; a large change with high conflict against the fork's GGUF integration. Revisit only on a real GPU-reset report |
| Corrupted database recovery at startup (upstream `3710ff9` subset, #53 item 12a) | Declined 2026-10-25: a corrupted database has never been observed (SQLite in WAL mode, no `malformed`/`corrupt` in logs); replacing the database automatically at startup adds data risk for a failure we do not see |
| Main window recovery: main-webview crash handling and window recreation (upstream `3710ff9` subset, `3079d94`, #53 item 12c) | Declined 2026-10-25: the main window has never crashed or failed to create; no log evidence |
| Full binary-IPC port (upstream `85c9e69`, #53): framed request bodies, raw PCM save, raw local/cloud transcription, binary diagnostics | Declined 2026-10-27: the native `Uint8Array.toBase64` encoder (#87, merged via PR #88 as `3c387c5`) removes the base64 cost without changing the IPC protocol, and the Rust side was not the bottleneck (26 ms vs 6 ms for 300 s); the outcomes that mattered are covered separately by #84 (raw PCM read for history reprocessing) and #86 (direct recording copy to Downloads) |
| Blob playback from upstream `85c9e69` | Declined 2026-10-27: playback stays on data URLs from `read_audio_file`; Rust encodes once per play, and an object URL would add manual `revokeObjectURL` on track change and unmount. `read_audio_file` is still needed by `asrCorrection`. Revisit only on reports of slow playback start for long recordings |
| Updater hardening from upstream `c405ccd` | Declined: the fork keeps its pinned URL, mandatory SHA-512, in-memory auth and no install-on-exit; the manifest version/hash binding and hash-to-install race remain separate follow-ups |
| Upstream website redesign (`18165da`) | Declined: the fork does not ship the upstream site; no functional value for the desktop app |

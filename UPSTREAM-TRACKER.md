# Upstream port tracker

Progress list for porting upstream `crosswk/SayIt` features into this fork.
Covers upstream 0.2.1 (`8687e9b`) and 0.2.2 (`c704300`), plus follow-up fixes.

- Detailed per-topic analysis lives in the git-ignored `dev-scripts/upstream-slices/` folder.
- The local `dev-scripts/upstream-decisions/` journal remains the authoritative record for accept/reject decisions on upstream commits; this file mirrors progress in one readable list.
- Update this file when a port lands or a decision changes. Keep one row per feature.

Last updated: 2026-10-05 (audit base `e65cf5e`; later commits already moved several items to Ported).

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
| History/AI polish fixes: blank completion is an error, keyless providers via catalog, request-time attribution, blank keyed model guard | `6a5bfc5` |
| Settings accessibility and AI state fixes | `2ad1715` |
| Hotword capability matrix (Rust) + dynamic Dictionary support table + ignored-hotword diagnostics | `df2ef41` |

## Partial

| Feature | What is missing |
| --- | --- |
| Qwen models | Qwen Audio 3.0 selectable fallback; Omni HTTP/chat profile; legacy Omni alias migration for old profiles |
| Microphones | Picker-only cleanup in `e0b376e`: duplicate default/identical IDs hidden, communications route labelled and hidden when redundant with the system default (kept when saved or targeting another device), saved routes preserved, last-listed default device shown only on an unambiguous match (not a live route guarantee). Recorder overlay label parity is unassessed; saved-ID migration is deliberately out of scope. |
| Paste | `WM_PASTE` is sent; effect (did the field change) is not verified |
| Late ASR result | Opt-in permanent suppression in uncommitted working tree: within the existing 15 s grace, no automatic insertion; History saves when enabled and successful, otherwise the text is discarded. Suppressed results do not update personalization statistics. Upstream per-run Esc abandonment remains unported. |
| Server AI | Fixed temperature; no reasoning settings |
| AI policy in History | Targeted fixes only; cloud/local reprocessing not fully unified (accepted divergence) |
| Recorder failure lifecycle | Cards done; upstream stuck-insertion watchdog intentionally skipped so far |
| Overlay live captions | Unconfirmed flicker risk when warning payloads lack `streaming`; verify visually before treating as a bug |
| Updater card | Consent-based updater has no downloaded-waiting state; needs design before any port |
| Documentation | README does not list all cloud ASR providers; hotword docs stay generic |

## Open (not started)

- Server reasoning config (skip temperature / `reasoning_effort`).
- OpenAI Chat Audio as a separate route (distinct from the custom OpenAI-compatible `chat` protocol).
- Fresh review of upstream topics not covered in the first pass: recorder/paste deltas (8687e9b:09), rust shell (10), UI misc (11), services misc (c704300:05c).
- Fork release notes: reflect 0.2.2 feature highlights.

## Deferred

| Feature | Reason |
| --- | --- |
| GPU device selection | Deferred 2026-10-02: only useful with 2+ GPUs, selector hidden on single-GPU machines, no live validation possible here; upstream patch and crate support are ready when needed |
| Paste effect verification | Deferred 2026-10-04 by choice. `WM_PASTE` reports message delivery, not observed text insertion; do not port upstream retries without separate approval and Windows evidence. |
| OpenAI Realtime / Gemini Live | Not validated with a real key; keep buffered routes |

## Won't do

| Feature | Decision |
| --- | --- |
| Zhipu/GLM preset and forced GLM thinking | Reachable manually via OpenAI-compatible; forced reasoning rejected as risky for all providers |
| ASR catalog redesign / one-card-per-platform UI | Fork keeps its service-profile model (deliberate UX choice) |
| Upstream release metadata (versions, changelogs, highlights files) | Fork owns versioning and release tooling |
| Upstream-only docs and assets (community links, Chinese README images) | No functional value for the fork |

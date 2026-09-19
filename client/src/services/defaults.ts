/**
 * Centralized default configuration
 *
 * Every getSetting() default is defined here.
 * Changing a default means editing this one file — no global search-and-replace.
 *
 * Prompt-related configuration (kept separately because it is long):
 *   - Built-in polish presets → BUILTIN_PRESETS in src/services/store.ts
 *   - App prompt rules → BUILTIN_APP_RULES in src/services/personalization/defaults.ts
 */

export const MIC_BOOST_VALUES = ['1', '2', '3', '5', 'auto'] as const
export type MicBoostSetting = (typeof MIC_BOOST_VALUES)[number]
export const DEFAULT_MIC_BOOST: MicBoostSetting = '3'
export const DEFAULT_BUILTIN_PROMPT_LANGUAGE = 'en'
export const LEGACY_BUILTIN_PROMPT_LANGUAGE = 'zh-CN'

export interface MicBoostConfig {
  setting: MicBoostSetting
  gain: number
  autoGainControl: boolean
}

export function resolveMicBoost(value: unknown): MicBoostConfig {
  const setting: MicBoostSetting = typeof value === 'string'
    && (MIC_BOOST_VALUES as readonly string[]).includes(value)
    ? value as MicBoostSetting
    : DEFAULT_MIC_BOOST

  return {
    setting,
    gain: setting === '2'
      ? 2
      : setting === '3'
        ? 3
        : setting === '5' ? 5 : 1,
    autoGainControl: setting === 'auto',
  }
}

export const DEFAULTS: Record<string, unknown> = {

  // ── UI language ──
  // Governs **UI text only**; it does not change the recognition language. The settings
  // layer already has several "language" keys (`speechInput.language` is the ASR speech
  // language, Preset decides the output language), so this key must carry the `ui.` prefix
  // and must not be named just `language`.
  'ui.language': 'auto', // 'auto' follows the system locale; otherwise 'en' | 'uk'

  // ── Work mode ──
  workMode: 'server', // Options: 'server' | 'cloud_api' | 'local'

  // ── Shortcuts ──
  // Push-to-talk. Legacy single keys keep the DOM code; combos use the physical code
  // format, e.g. 'ControlLeft+MetaLeft' or 'ControlLeft+KeyK'.
  // ⚠️ The default key must not be Shift: holding the right Shift for ~8 seconds trips
  // Windows FilterKeys, so recording never stops on key release (see PTT_FORBIDDEN_CODES
  // in lib/shortcutKeys.ts). This used to be 'ShiftRight', which bound every fresh install
  // to that key out of the box. Right Ctrl is nearby, has no accessibility trap, and does
  // not collide with the hands-free default (right Alt).
  // ⚠️ Changing this must be mirrored in Rust: the seed defaults in
  // src-tauri/src/storage/mod.rs, the fallback in main.rs, and
  // PttKeyConfig::fallback() in keyboard/mod.rs.
  shortcutPTT: 'ControlRight',
  shortcutHandsFree: 'AltRight', // Hands-free mode. Defaults to the right Alt single key. Also accepts combos like 'Control+Shift+S'
  // AI-cleanup master shortcut. Empty = not registered, so an upgrade never silently
  // grabs a global combo the user already owns.
  shortcutToggleAi: '',

  // ── Microphone ──
  selectedMic: '', // Device ID; empty string = system default
  muteSystemAudioWhileRecording: false, // Mute other system audio while push-to-talk is held (prevents speaker bleed into the mic). Off by default
  // Browser noise suppression. On by default (machines with a high noise floor need it);
  // suppression is tuned for "comfortable to a human ear" and may shave off detail ASR
  // wants, so users with a clean mic environment can turn it off to compare accuracy.
  micNoiseSuppression: true,
  micBoost: DEFAULT_MIC_BOOST, // '1' = off; '2', '3', '5' = fixed gain; 'auto' = browser AGC

  // ── Text insertion ──
  protectClipboard: true, // After inserting text, restore the clipboard to its pre-insert content so the user's clipboard is not occupied. On by default

  // ── AI cleanup ──
  aiEnabled: true, // Whether AI cleanup is enabled. Options: true | false
  // 0 = clean every utterance; greater than 0 = call the AI only when the recording
  // reaches that many seconds (max 300 seconds).
  aiMinDurationSec: 0,
  // Read text around the cursor / the selection and hand it to the AI for context-aware
  // continuation and voice editing. Reads document content, so it is off by default.
  contextAwareWritingEnabled: false,
  aiPromptAppend: '', // Global appended prompt
  'ai.builtinPromptLanguage': DEFAULT_BUILTIN_PROMPT_LANGUAGE, // First-run default follows the UI locale; saved choices remain independent.

  // ── AI providers ──
  // These four are **the copy that is live at runtime**; the recording pipeline, history
  // re-runs, the diagnostics page, and feedback reporting all read only them. The "AI
  // Service" page writes them as one whole block on enable/save — never change one of them
  // individually elsewhere (a historical bug: the model was switched but the URL and key
  // still belonged to the previous provider).
  'cloudAi.provider': 'openai_compat', // Allowed values come from AI_PROVIDERS in features/settings/aiProviderCatalog.ts.
  'cloudAi.apiUrl': '',
  'cloudAi.apiKey': '',
  'cloudAi.model': '',
  // The "AI Service" list itself: one entry = provider + URL + key + model, read and written only by the settings page.
  'cloudAi.profiles': [],
  'cloudAi.activeProfileId': '',
  // The old "one config per provider" keys (cloudAi.<provider>.*) are flattened exactly
  // once. Without this marker, deleting all entries would let the next visit "rescue" them
  // back. The old keys are never deleted, so downgrades keep working.
  'cloudAi.profilesMigrated': false,

  // ── ASR (cloud API) ──
  // Allowed values come from ASR_PROVIDERS in features/settings/asrProviderCatalog.ts:
  // 'doubao_v2' | 'qwen' | 'qwen_audio_stream' | 'qwen_realtime' | 'qwen_omni_35_*' | 'mimo' | 'groq_whisper'
  'cloudAsr.provider': 'doubao_v2',
  // Runtime mirror of the credentials that are in effect this run. Doubao computes its
  // console generation and writes these two keys: the new console has only an API Key and
  // appId is necessarily an empty string (Rust uses it to pick between the two auth
  // header generations).
  'cloudAsr.apiKey': '',
  'cloudAsr.appId': '', // Only needed by the legacy Doubao console
  // Doubao console generation and its own keys (the two generations do not share a key;
  // stored separately so switching back does not lose either)
  'cloudAsr.doubao.console': 'new', // 'new' = API Key only | 'legacy' = App ID + Access Token
  'cloudAsr.doubao.consoleKey': '', // API Key of the new console
  'cloudAsr.omniSystemPrompt': '', // System prompt for Qwen Omni mode
  // Service list: one card = one full configuration (provider + that platform's credentials); the same provider can be stored multiple times
  'cloudAsr.profiles': [],
  'cloudAsr.activeProfileId': '',
  // Which services have already been auto-created. Deliberately not a boolean
  // "migration done" marker — remembering "who was patched" both self-heals after logic
  // fixes and refuses to resurrect cards the user deleted on purpose.
  'cloudAsr.autoCreatedProviders': [],

  // ── Speech input language ──
  // Shared preferred speech language for every recognition mode (local, server,
  // cloud_api). Input side only: the UI locale and each preset's output language
  // are separate concerns.
  'speechInput.language': 'auto',

  // ── ASR (local) ──
  // Allowed values are the ids in catalog.rs: 'sensevoice-small-gguf' (default, fastest)
  // | 'funasr-nano-2512-gguf' | 'qwen3-asr-0.6b-gguf'
  // | 'qwen3-asr-1.7b-q4-gguf' | 'qwen3-asr-1.7b-gguf' (most accurate)
  // | 'whisper-small-gguf' | 'whisper-large-v3-turbo-gguf'
  'localAsr.modelId': 'sensevoice-small-gguf',
  // GGUF weights are published on HuggingFace. The value must match a catalog source.
  'localAsr.downloadSource': 'HuggingFace', // optional: 'HuggingFace'
  'localAsr.model': '',
  // Compute backend preference for the GGUF engine. 'auto' = use the GPU when there is
  // one, otherwise the CPU. Machines without the GPU acceleration pack are always on CPU;
  // this value does not affect functionality, only speed.
  'localAsr.accelerator': 'auto', // Options: 'auto' | 'cpu' | 'gpu'
  // Unload the local model after this many idle minutes (measured release: 350 MB to
  // 2.6 GB of memory). 0 = never unload. The default keeps it resident so the next
  // recognition does not pay the "load + warm-up" wait again; memory-tight users can
  // choose to release it after 10 / 30 / 60 idle minutes in the local mode settings.
  'localAsr.unloadIdleMinutes': 0,

  // ── Server ──
  // Options: 'auto' | 'zh' | 'en'. Sent with every recognition to the server, where
  // asr.py's _resolve_language maps it to Chinese / English; 'auto' = let the model
  // decide.
  // (The comment used to say 'Chinese' | 'English' | 'Cantonese' — those are internal
  // server-side values; the client never sent those strings.)
  // AI source in server mode. managed = built into the server; custom = the server only
  // does ASR and the client calls the current AI profile.
  'server.aiSource': 'managed', // Options: 'managed' | 'custom'

  // ── Overlay window ──
  overlayWaveTheme: 'black-rainbow', // Options: 'black-rainbow' | 'black-blue' | 'black-white'
  overlayShowDuration: true, // Whether to show the recording duration. Options: true | false
  overlayWidth: 'short', // Options: 'short' | 'medium' | 'long'

  // ── Streaming live display ──
  // When on, streaming-capable ASR models (Doubao, Qwen realtime) show live text in the
  // overlay during recognition. The finished text is still handed to the AI as usual.
  // Options: true | false
  streamingDisplayEnabled: false,

  // ── Hotword injection into the AI prompt ──
  // When on, AI cleanup receives your hotword list to help correct/keep proper nouns.
  // Off by default. Options: true | false
  injectHotwordsToPrompt: false,

  // ── Chimes ──
  readySoundEnabled: true, // Recording-ready chime. Options: true | false

  // ── App settings ──
  // autoCheckUpdate controls ONLY the automatic metadata check (a small manifest GET
  // at startup and every six hours). Downloading and installing always require the
  // user's explicit "Download and install" action, so this switch cannot cause an
  // install — it only decides whether the app notices new releases on its own.
  autoCheckUpdate: true, // Whether to check for updates. Options: true | false
  // pendingUpdate existed for the pre-fork install-on-exit flow; that flow is gone
  // (see commands/system.rs clear_legacy_update_artifacts, which deletes any value
  // left behind by older versions). Do not add a default for it back.
  historyEnabled: true, // Save history (text + audio). When off, no new entries are stored — useful on shared computers. Options: true | false
  audioRetentionEnabled: true, // Keep recording files. Options: true | false
  audioRetentionDays: -1, // Recording retention in days. Options: 7 | 30 | 90 | -1 (forever)
  logRetentionDays: 30, // Log retention in days. Options: 7 | 15 | 30 | 90

  // ── WebDAV backup ──
  // A backup always contains configuration; history and recordings are optional. Both
  // default to false: a recording library can be several GB, and cloud drives
  // (especially the free Nutstore tier) have monthly traffic quotas — enabling them by
  // default would make an expensive decision on the user's behalf.
  // ⚠️ The Rust side (commands/webdav.rs) keeps its own copies of these defaults
  // (setting_bool's unwrap_or(false) and DEFAULT_KEEP_COUNT); changing one side requires
  // changing the other — when the two disagree, what the UI shows and what actually gets
  // uploaded are not the same thing.
  'webdav.enabled': false, // Automatic periodic backup. Options: true | false
  'webdav.url': '', // Directory URL; HTTPS only (Basic auth means the password travels in clear text otherwise)
  'webdav.username': '',
  'webdav.password': '', // Nutstore requires an "app password", not the login password
  'webdav.includeHistory': false, // Back up history
  'webdav.includeAudio': false, // Back up recording files (large; warns when enabled)
  'webdav.intervalHours': 24, // Backup interval in hours. Options: 24 | 72 | 168
  'webdav.keepCount': 5, // Copies kept on the server. Options: 3 | 5 | 10
  'webdav.lastBackupAt': 0, // Time of the last **successful** backup (ms). The interval check reads only this
  'webdav.lastAttemptAt': 0, // Time of the last attempt (ms), used for failure backoff
  // Last backup result { at, ok, fileName, bytes, includeHistory, includeAudio, error }.
  // Failures are recorded too: a backup that silently failed for months looks exactly
  // like a healthy one in the UI.
  'webdav.lastResult': null,

  // ── Text post-processing (client-side normalization that does not need AI) ──
  textPostProcess: {
    autoSegment: true, // Smart segmentation (fast mode only), on by default
    normalizeNumbers: true, // Number normalization: percents/decimals/fractions/structured integers, on by default
    stripTrailingPunctuation: false, // Strip sentence-final punctuation
    punctuationToSpace: false, // Replace punctuation with spaces
  },

  // ── Hotwords ──
  hotwordLearning: null,

  // ── Onboarding ──
  onboardingVersion: '', // Version whose onboarding was completed; empty string = not completed

  // ── Remote notices ──
  dismissedNoticeIds: [], // Ids of notices the user dismissed
}

/**
 * Get the default value for a key.
 * If the key is not in DEFAULTS, returns the provided fallback.
 */
export function getDefault<T>(key: string, fallback?: T): T {
  if (key in DEFAULTS) {
    return DEFAULTS[key] as T
  }
  return fallback as T
}

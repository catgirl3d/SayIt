// Cloud ASR provider catalog, service profile parsing, and latency tiers.
//
// The structure mirrors the "AI Services" page: one card = one complete configuration (provider,
// platform credentials, and a selected model where supported), including several per provider
// (e.g. two Bailian accounts, two sets of Doubao keys). The active card is chosen by activeProfileId.
//
// Cloud providers use dedicated Rust transports; only the OpenAI-compatible profile accepts a
// per-profile base URL, which is validated before credentials or audio are sent.
//
// Re-pasting a key for the same platform is not solved by storing keys per platform (that would
// stop a card from being a complete configuration). Instead, a new card seeds the credentials from
// the platform's previously saved profile, and the editor states where they came from.

import {
  describeDoubaoMissing,
  effectiveDoubaoCredentials,
  type DoubaoConsole,
  type DoubaoCredentials,
} from '@/lib/cloudAsrCreds'
import {
  buildCloudAsrExtra,
  CUSTOM_ASR_PROVIDER,
  isQwenOmniProvider,
  resolveQwenOmniModel,
} from '@/lib/asrModels'
export { CUSTOM_ASR_PROVIDER } from '@/lib/asrModels'
import type { SpeechInputLanguage } from '@/services/speechInputLanguage'

/** 凭据归属的平台。同平台的服务用同一种密钥形态。 */
import { t } from '@/i18n'

export type AsrPlatform = 'doubao' | 'qwen' | 'mimo' | 'groq' | 'openai' | 'gemini' | 'openrouter' | 'deepgram' | 'custom'

export interface AsrPlatformInfo {
  label: string
  /** 去哪儿领密钥 */
  consoleUrl: string
}

// label 用 getter：这是模块级常量，普通字段会把加载那一刻的语言固化下来。
// 见 aiProviderCatalog.ts 里 AiProvider.label 的注释。
export const ASR_PLATFORMS: Record<AsrPlatform, AsrPlatformInfo> = {
  doubao: { get label() { return t('asrPlatform.doubao') }, consoleUrl: 'https://console.volcengine.com/speech/app' },
  qwen: { get label() { return t('asrPlatform.qwen') }, consoleUrl: 'https://bailian.console.aliyun.com' },
  mimo: { get label() { return t('asrPlatform.mimo') }, consoleUrl: 'https://xiaoai.mi.com' },
  groq: { label: 'Groq', consoleUrl: 'https://console.groq.com/keys' },
  openai: { label: 'OpenAI', consoleUrl: 'https://platform.openai.com/api-keys' },
  gemini: { label: 'Gemini', consoleUrl: 'https://aistudio.google.com/app/apikey' },
  openrouter: { label: 'OpenRouter', consoleUrl: 'https://openrouter.ai/settings/keys' },
  deepgram: { label: 'Deepgram', consoleUrl: 'https://console.deepgram.com' },
  custom: { get label() { return t('asrPlatform.openaiCompat') }, consoleUrl: '' },
}

export interface AsrProviderEntry {
  /** 存进 cloudAsr.provider 的值，也是 Rust 侧分发用的 key */
  id: string
  /** 卡片标题，短 */
  label: string
  /** Default model ID shown in the provider catalog. */
  model: string
  /** Selectable models supported by this provider. */
  models?: readonly string[]
  platform: AsrPlatform
  /** 一句定位，说清「什么时候选它」 */
  blurb: string
  /**
   * Region for the built-in endpoint and provider account.
   * Global services may be less reliable to reach from mainland China, so label them to
   * distinguish network availability from invalid credentials.
   */
  availability: 'mainland_china' | 'global' | 'custom'
  /** 边说边出字（实时字幕） */
  streaming?: boolean
  /** 识别与 AI 整理一步完成，不需要单独配 AI 服务 */
  omni?: boolean
  /** 需要百炼「业务空间 ID」才能用 */
  needsWorkspaceId?: boolean
  customEndpoint?: boolean
}

export type CustomAsrProtocol = 'transcriptions' | 'chat' | 'auto'

const OPENAI_TRANSCRIPTION_MODELS = [
  'gpt-transcribe',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'whisper-1',
] as const

const GEMINI_TRANSCRIPTION_MODELS = ['gemini-3.5-transcribe'] as const

// OpenRouter API slugs do not reliably match their display names.
const OPENROUTER_TRANSCRIPTION_MODELS = [
  'openai/gpt-transcribe',
  'qwen/qwen3-asr-flash-2026-02-10',
  'qwen/qwen3-asr-1.7b',
  'qwen/qwen3-asr-0.6b',
  'microsoft/mai-transcribe-2',
  'google/chirp-3',
  'microsoft/mai-transcribe-1.5',
  'openai/gpt-4o-transcribe',
  'openai/gpt-4o-mini-transcribe',
  'openai/whisper-large-v3-turbo',
  'openai/whisper-large-v3',
  'openai/whisper-1',
  'deepgram/nova-3',
  'meta/muse-voice-transcribe-1.0',
  'x-ai/grok-stt-1.0',
  'mistralai/voxtral-mini-transcribe',
  'mistralai/voxtral-small-24b-2507-stt',
  'mistralai/voxtral-mini-3b-2507',
  'nvidia/parakeet-tdt-0.6b-v3',
  'nvidia/nemotron-3.5-asr-streaming-multilingual-0.6b',
  'fish-audio/transcribe-1',
] as const

/**
 * 内置服务清单。顺序即卡片顺序，也是新建时下拉的顺序：把最推荐的放前面。
 *
 * label 刻意不带模型名后缀（模型名单独一行小字），否则卡片标题会被
 * 「千问 3.5 Omni Plus（qwen3.5-omni-plus，ASR+AI）」这种括号串撑爆。
 *
 * Each blurb should answer when to choose that provider and distinguish it from
 * the others. Earlier copy listed strengths independently (such as accuracy and
 * speed on multiple entries), leaving users without a useful selection reason.
 *
 * Accuracy comparisons are conditional. Doubao was the strongest for Chinese
 * with live captions off; enabling captions dropped it by a tier. Historical
 * Qwen Audio 3.0 comparisons showed the reverse, with captions on. Lower-ranked
 * services were described honestly (Qwen realtime below Audio 3.0, MiMo with
 * middling accuracy), but are retained because some users may only have an
 * account or network that works with that provider.
 *
 * Refer to other entries by product name, never relative catalog position.
 * These conclusions came from hands-on use, not benchmarks. The Qwen Audio
 * accuracy comparison covered 3.0 only and provides no accuracy or latency
 * evidence for 3.1.
 */
export const ASR_PROVIDERS: AsrProviderEntry[] = [
  {
    id: 'doubao_v2',
    get label() { return t('asrProvider.doubao') },
    model: 'Doubao-Seed-ASR-2.0',
    platform: 'doubao',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.doubaoBlurb') },
  },
  // Second after Doubao as the streaming-caption option. The historical comparison
  // found Audio 3.0 stronger than Doubao with captions on; Doubao's strongest
  // Chinese accuracy required captions off, and enabling them dropped it a tier.
  // That comparison says nothing about 3.1 accuracy or latency. This UI flow does
  // not require a workspace ID; the generic-host probe verified 3.0 only, not 3.1.
  {
    id: 'qwen_audio_stream',
    get label() { return t('asrProvider.qwenAudioStream') },
    model: 'qwen-audio-3.1-asr-flash-streaming',
    platform: 'qwen',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.qwenAudioStreamBlurb') },
    streaming: true,
  },
  {
    id: 'qwen',
    get label() { return t('asrProvider.qwen') },
    model: 'qwen3-asr-flash',
    platform: 'qwen',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.qwenBlurb') },
  },
  {
    id: 'qwen_realtime',
    get label() { return t('asrProvider.qwenRealtime') },
    model: 'qwen3-asr-flash-realtime',
    platform: 'qwen',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.qwenRealtimeBlurb') },
    streaming: true,
    needsWorkspaceId: true,
  },
  {
    id: 'qwen_omni_35_plus',
    get label() { return t('asrProvider.omniPlus') },
    model: 'qwen3.5-omni-plus',
    platform: 'qwen',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.omniPlusBlurb') },
    omni: true,
  },
  {
    id: 'qwen_omni_35_flash',
    get label() { return t('asrProvider.omniFlash') },
    model: 'qwen3.5-omni-flash',
    platform: 'qwen',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.omniFlashBlurb') },
    omni: true,
  },
  {
    id: 'qwen_omni_38_realtime',
    get label() { return t('asrProvider.omni38Realtime') },
    model: 'qwen3.8-omni-flash-realtime',
    platform: 'qwen',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.omni38RealtimeBlurb') },
    omni: true,
  },
  {
    id: 'mimo',
    get label() { return t('asrProvider.mimo') },
    model: 'mimo-v2.5-asr',
    platform: 'mimo',
    availability: 'mainland_china',
    get blurb() { return t('asrProvider.mimoBlurb') },
  },
  // Deepgram: the first global provider with real live captions. All four SayIt
  // languages (ru/uk/en/zh) are documented for Nova-3; mixed Russian-English
  // speech uses its multilingual mode. Interim text is per-segment, so the
  // overlay shows committed segments plus the current one.
  {
    id: 'deepgram',
    get label() { return t('asrProvider.deepgram') },
    model: 'nova-3',
    platform: 'deepgram',
    availability: 'global',
    get blurb() { return t('asrProvider.deepgramBlurb') },
    streaming: true,
  },
  {
    id: 'groq_whisper',
    get label() { return t('asrProvider.groq') },
    model: 'whisper-large-v3-turbo',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    platform: 'groq',
    availability: 'global',
    get blurb() { return t('asrProvider.groqBlurb') },
  },
  {
    id: 'openai_transcribe',
    get label() { return t('asrProvider.openai') },
    model: OPENAI_TRANSCRIPTION_MODELS[0],
    models: OPENAI_TRANSCRIPTION_MODELS,
    platform: 'openai',
    availability: 'global',
    get blurb() { return t('asrProvider.openaiBlurb') },
  },
  {
    id: 'gemini_transcribe',
    get label() { return t('asrProvider.gemini') },
    model: GEMINI_TRANSCRIPTION_MODELS[0],
    models: GEMINI_TRANSCRIPTION_MODELS,
    platform: 'gemini',
    availability: 'global',
    get blurb() { return t('asrProvider.geminiBlurb') },
  },
  {
    id: 'openrouter_transcribe',
    get label() { return t('asrProvider.openrouter') },
    model: OPENROUTER_TRANSCRIPTION_MODELS[0],
    models: OPENROUTER_TRANSCRIPTION_MODELS,
    platform: 'openrouter',
    availability: 'global',
    get blurb() { return t('asrProvider.openrouterBlurb') },
  },
  {
    id: CUSTOM_ASR_PROVIDER,
    get label() { return t('asrProvider.openaiCompat') },
    model: '',
    platform: 'custom',
    availability: 'custom',
    get blurb() { return t('asrProvider.openaiCompatBlurb') },
    customEndpoint: true,
  },
]

export function findAsrProvider(id: string): AsrProviderEntry | undefined {
  return ASR_PROVIDERS.find((p) => p.id === id)
}

/**
 * 地区提示，**只在需要提醒时才给字**。
 *
 * `mainland_china` 刻意返回空串：内置清单里绝大多数都是国内端点，那是默认情形，
 * 每张卡上都挂一句「面向中国大陆账号」等于把噪音重复七遍，还把真正要紧的
 * 「这个要海外网络才连得上」冲淡了。availability 字段本身保留 —— 它是数据，
 * 只是这一条不值得占界面上的字。
 */
export function asrAvailabilityLabel(entry: AsrProviderEntry): string {
  if (entry.customEndpoint) return ''
  switch (entry.availability) {
    case 'global': return t('asrProvider.regionGlobal')
    default: return ''
  }
}

/** 同一平台下有哪些可选服务 */
export function providersOfPlatform(platform: AsrPlatform): AsrProviderEntry[] {
  return ASR_PROVIDERS.filter((p) => p.platform === platform)
}

// ─────────────────────────── 检测结果 ───────────────────────────

/**
 * 一次识别测试的结论。
 *
 * 存的是结论而不只是耗时：只有耗时的话，界面上能说出「多快」，说不出「行不行」。
 * 不可用也要留痕，否则用户点完测试、切走再回来，只看到一张和没测过一样的卡。
 */
export interface AsrCheck {
  ok: boolean
  /** 测试时间戳，用来判断结论是否还新鲜 */
  at: number
  /** 转写这段测试音频花了多久（毫秒），只有测通才有 */
  latencyMs?: number
  /** 测试音频时长（秒）。延迟要除以它才能横向比较，所以一起存 */
  audioSec?: number
  /** 不可用时的原因，一句话 */
  reason?: string
}

function isFiniteNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function parseCheck(raw: unknown): AsrCheck | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  if (typeof v.ok !== 'boolean') return undefined
  const at = isFiniteNumber(v.at)
  if (at === undefined) return undefined
  return {
    ok: v.ok,
    at,
    latencyMs: isFiniteNumber(v.latencyMs),
    audioSec: isFiniteNumber(v.audioSec),
    reason: typeof v.reason === 'string' && v.reason ? v.reason : undefined,
  }
}

// ─────────────────────────── 服务档案 ───────────────────────────

/**
 * A speech-recognition profile contains its provider, platform credentials, and selected model.
 *
 * 凭据直接挂在档案上（而不是按平台共享），这样一张卡就是一份自洽的完整配置，
 * 也才可能同时存两个账号。重复粘密钥的问题由「新建时自动沿用同平台上一份」解决。
 */
export interface AsrProfile {
  id: string
  /** 供应商 id，必须是 ASR_PROVIDERS 里的一个 */
  provider: string
  /** Selected model for providers that expose model choices. */
  model: string
  /** Custom OpenAI-compatible endpoint base URL. Present only for custom profiles. */
  baseUrl?: string
  /** Custom OpenAI-compatible request protocol. Present only for custom profiles. */
  protocol?: CustomAsrProtocol
  /** 千问 / 小米：API Key；豆包：当前控制台代次那一份密钥 */
  apiKey: string
  /** 豆包旧版控制台的 App ID */
  appId: string
  /** 豆包控制台代次 */
  console: DoubaoConsole
  /** 豆包另一代的密钥，切换代次时原样保留，不用重新粘 */
  otherKey: string
  /** 百炼业务空间 ID（流式识别需要） */
  workspaceId: string
  /** Omni 模型的 System Prompt（识别与整理一体，属于这份服务的行为） */
  omniPrompt: string
  /** 上次识别测试的结论 */
  check?: AsrCheck
}

export function makeAsrProfileId(): string {
  return `asr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 一份空白档案。provider 默认给最推荐的那个。 */
export function emptyAsrProfile(provider = ASR_PROVIDERS[0].id): AsrProfile {
  const entry = findAsrProvider(provider)
  return {
    id: makeAsrProfileId(),
    provider,
    model: entry?.model ?? '',
    ...(entry?.customEndpoint && { baseUrl: '', protocol: 'transcriptions' as const }),
    apiKey: '',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: '',
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/**
 * Tolerant parser for the stored profile list.
 *
 * Storage may have been hand-edited or written by an older version; bad entries are
 * dropped entirely instead of taking the whole page down. Entries whose provider is
 * not in the built-in catalog are dropped too — keeping them would only render a
 * card that cannot be clicked.
 *
 * Replacing the stored model with the current catalog default invalidates the stored
 * check: the verdict belongs to the model that was actually tested, so it must not
 * survive a substitution. The same rule drops a check when the tested model cannot be
 * established (legacy entries without a saved model) — a check whose provenance is
 * unknown is not treated as valid.
 */
export function parseAsrProfiles(raw: unknown): AsrProfile[] {
  if (!Array.isArray(raw)) return []
  const out: AsrProfile[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const v = item as Record<string, unknown>
    const provider = str(v.provider)
    const entry = findAsrProvider(provider)
    if (!entry) continue
    const storedModel = str(v.model).trim()
    const model = entry.customEndpoint
      ? storedModel
      : entry.models
        ? entry.models.includes(storedModel) ? storedModel : entry.model
        : entry.model
    const id = str(v.id) || makeAsrProfileId()
    if (seen.has(id)) continue
    seen.add(id)
    const consoleRaw = str(v.console)
    out.push({
      id,
      provider,
      model,
      ...(entry.customEndpoint && {
        baseUrl: str(v.baseUrl),
        protocol: v.protocol === 'chat' || v.protocol === 'auto' ? v.protocol : 'transcriptions',
      }),
      apiKey: str(v.apiKey),
      appId: str(v.appId),
      console: consoleRaw === 'legacy' ? 'legacy' : 'new',
      otherKey: str(v.otherKey),
      workspaceId: str(v.workspaceId),
      omniPrompt: str(v.omniPrompt),
      check: storedModel !== '' && storedModel === model ? parseCheck(v.check) : undefined,
    })
  }
  return out
}

export interface AsrProviderConfig {
  provider: string
  api_key: string
  app_id: string
  extra?: Record<string, unknown>
}

export function buildAsrProviderConfig(
  profile: AsrProfile,
  language: SpeechInputLanguage,
): AsrProviderConfig {
  const entry = findAsrProvider(profile.provider)
  const credentials = effectiveAsrCredentials(profile)
  const model = entry?.customEndpoint ? profile.model.trim() : profile.model
  const extra = buildCloudAsrExtra(
    profile.provider,
    language,
    entry?.omni ? profile.omniPrompt || undefined : undefined,
    model,
  )
  return {
    provider: entry?.omni ? 'qwen_omni' : profile.provider,
    api_key: credentials.apiKey,
    app_id: credentials.appId,
    extra: entry?.customEndpoint
      ? {
        ...extra,
        base_url: profile.baseUrl?.trim() ?? '',
        protocol: profile.protocol ?? 'transcriptions',
      }
      : extra,
  }
}

export interface AsrRequestMetadata {
  engine: string
  model?: string
}

/**
 * Engine and model a request built from this profile actually uses. Live recognition
 * and history reprocessing both stamp their results with it, so the provider→model
 * decision lives here instead of being re-derived by each caller.
 */
export function resolveAsrRequestMetadata(profile: AsrProfile): AsrRequestMetadata {
  const entry = findAsrProvider(profile.provider)
  if (isQwenOmniProvider(profile.provider)) {
    return { engine: 'qwen_omni', model: resolveQwenOmniModel(profile.provider) }
  }
  const model = entry?.customEndpoint
    ? profile.model.trim()
    : entry?.models
      ? profile.model
      : entry?.model
  return { engine: profile.provider, model }
}

export function normalizeAsrProfileForSave(profile: AsrProfile): AsrProfile {
  if (!findAsrProvider(profile.provider)?.customEndpoint) return { ...profile }
  return { ...profile, model: profile.model.trim() }
}

export function isValidCustomAsrBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim())
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && Boolean(url.hostname)
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
  } catch {
    return false
  }
}

export function changeAsrProfileProvider(profile: AsrProfile, provider: string): AsrProfile {
  if (provider === profile.provider) return { ...profile }
  const nextEntry = findAsrProvider(provider)
  const crossedCustomEndpoint = findAsrProvider(profile.provider)?.customEndpoint || nextEntry?.customEndpoint
  const withoutCustomRoute = { ...profile }
  delete withoutCustomRoute.baseUrl
  delete withoutCustomRoute.protocol
  return {
    ...withoutCustomRoute,
    provider,
    model: nextEntry?.model ?? '',
    ...(crossedCustomEndpoint && {
      apiKey: '',
      otherKey: '',
      appId: '',
      console: 'new' as const,
      workspaceId: '',
    }),
    ...(nextEntry?.customEndpoint && { baseUrl: '', protocol: 'transcriptions' as const }),
  }
}

/** 启用项归一化：指向不存在的 id 时回落到第一条 */
export function resolveActiveAsrProfile(
  profiles: AsrProfile[],
  activeId: string,
): AsrProfile | null {
  return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? null
}

/**
 * 档案里的豆包字段 → lib/cloudAsrCreds 的凭据结构。
 *
 * 抽出来是因为两处都要用（算生效凭据、判断缺什么）。档案里只存「当前代次那把密钥」
 * 加「另一代那把」，映射时按代次还原成 consoleKey / accessToken。
 */
function toDoubaoCreds(profile: AsrProfile): DoubaoCredentials {
  return {
    console: profile.console,
    consoleKey: profile.console === 'new' ? profile.apiKey : profile.otherKey,
    accessToken: profile.console === 'new' ? profile.otherKey : profile.apiKey,
    appId: profile.appId,
  }
}

/**
 * 算出一份档案「本次生效的凭据」。
 *
 * 豆包新版控制台下 appId 必须是空串 —— Rust 侧就是靠它区分两代鉴权头，
 * 这条不变量的说明与测试在 lib/cloudAsrCreds.ts。
 */
export function effectiveAsrCredentials(profile: AsrProfile): { apiKey: string; appId: string } {
  if (findAsrProvider(profile.provider)?.platform === 'doubao') {
    return effectiveDoubaoCredentials(toDoubaoCreds(profile))
  }
  return { apiKey: profile.apiKey.trim(), appId: '' }
}

/**
 * 这份档案还缺什么才能用（空串 = 齐了）。文案直接可展示。
 *
 * 豆包那套直接委托 describeDoubaoMissing，不再自己抄一遍：抄的那版曾经把
 * 「还没填 API Key」写成没有空格的「还没填API Key」，而同一句话会和左下角就绪指示
 * 同屏出现，差一个空格就露馅。同一句用户可见文案只该有一个出处。
 */
export function describeAsrMissing(profile: AsrProfile): string {
  const entry = findAsrProvider(profile.provider)
  if (entry?.customEndpoint) {
    if (!profile.baseUrl?.trim()) return t('asrProvider.missingCustomUrl')
    if (!isValidCustomAsrBaseUrl(profile.baseUrl)) return t('asrProvider.invalidCustomUrl')
    if (!profile.model.trim()) return t('asrProvider.missingCustomModel')
    return ''
  }
  if (entry?.platform === 'doubao') {
    return describeDoubaoMissing(toDoubaoCreds(profile))
  }
  return profile.apiKey.trim() ? '' : t('asrProvider.missingKey')
}

/**
 * 密钥尾巴，用来区分同一家的多份配置。
 *
 * 同供应商的两张卡在界面上只差凭据，不给个区分标记就成了两张一模一样的卡，
 * 用户不知道哪张是哪个账号。只露最后 4 位：够区分，又不算把密钥显示出来。
 */
export function keyFingerprint(profile: AsrProfile): string {
  const key = effectiveAsrCredentials(profile).apiKey
  return key.length >= 4 ? `••${key.slice(-4)}` : ''
}

// ─────────────────────────── 延迟分档 ───────────────────────────

/**
 * 为什么不直接复用 AI 服务那套 gradeLatency：口径完全不同。
 *
 * 那边测的是一次极小的 LLM 往返，1 秒就算慢。这边测的是**把一段音频转写成文字**，
 * 一段 3 秒的话花 1 秒返回是正常水平。照搬阈值会把所有 ASR 服务标成「太慢」。
 *
 * 所以按 RTF（耗时 ÷ 音频时长）分档，界面上仍显示毫秒数（用户看得懂的是这个），
 * 但结论词来自 RTF —— 这样即使将来换了测试音频，档位也不会跟着漂。
 */
export type AsrLatencyTier = 'instant' | 'fast' | 'normal' | 'slow' | 'tooSlow'

export interface AsrLatencyGrade {
  tier: AsrLatencyTier
  label: string
  /** ok = 放心用，warn = 能用但拖，bad = 不建议用于口述 */
  tone: 'ok' | 'warn' | 'bad'
}

/** RTF 分界值集中在这里，想调手感只改这一处 */
const RTF_THRESHOLDS = { instant: 0.15, fast: 0.3, normal: 0.5, slow: 0.8 } as const

export function gradeAsrLatency(latencyMs: number, audioSec: number): AsrLatencyGrade {
  // 音频时长缺失或不合理时不硬猜档位，只说「已测通」，避免给出一个凭空的结论
  if (!Number.isFinite(audioSec) || audioSec <= 0) {
    return { tier: 'normal', label: t('grade.tested'), tone: 'ok' }
  }
  const rtf = latencyMs / (audioSec * 1000)
  if (rtf < RTF_THRESHOLDS.instant) return { tier: 'instant', label: t('grade.instant'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.fast) return { tier: 'fast', label: t('grade.fast'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.normal) return { tier: 'normal', label: t('grade.normal'), tone: 'ok' }
  if (rtf < RTF_THRESHOLDS.slow) return { tier: 'slow', label: t('grade.slow'), tone: 'warn' }
  return { tier: 'tooSlow', label: t('grade.tooSlow'), tone: 'bad' }
}

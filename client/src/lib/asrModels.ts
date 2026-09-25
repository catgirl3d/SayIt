import type { SpeechInputLanguage } from '@/services/speechInputLanguage'

/**
 * ASR 供应商 key → 实际模型 ID 映射
 */

const QWEN_OMNI_MODEL_MAP: Record<string, string> = {
  qwen_omni_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_plus: 'qwen3.5-omni-plus-realtime',
  qwen_omni_35_flash: 'qwen3.5-omni-flash-realtime',
  qwen_omni_38_realtime: 'qwen3.8-omni-flash-realtime',
  qwen_omni_flash: 'qwen3-omni-flash-realtime',
  qwen_omni_turbo: 'qwen-omni-turbo-realtime',
}

/** 判断是否为 Qwen Omni 系列模型 */
export function isQwenOmniProvider(provider: string): boolean {
  return provider.startsWith('qwen_omni')
}

/** 根据供应商 key 解析 Qwen Omni 模型 ID，非 Omni 返回 undefined */
export function resolveQwenOmniModel(provider: string): string | undefined {
  return QWEN_OMNI_MODEL_MAP[provider]
}

/** ASR 供应商 key → 显示用的模型 ID */
const ASR_DISPLAY_MODEL_MAP: Record<string, string> = {
  doubao_v2: 'Doubao-Seed-ASR-2.0',
  qwen: 'qwen3-asr-flash',
  qwen_realtime: 'qwen3-asr-flash-realtime',
  qwen_audio_stream: 'qwen-audio-3.1-asr-flash-streaming',
  mimo: 'mimo-v2.5-asr',
  groq_whisper: 'whisper-large-v3-turbo',
  openai_transcribe: 'gpt-transcribe',
  gemini_transcribe: 'gemini-3.5-transcribe',
  openrouter_transcribe: 'openai/gpt-transcribe',
  ...QWEN_OMNI_MODEL_MAP,
}

/** 将内部供应商 key 映射为显示用的模型名称 */
export function resolveAsrDisplayModel(providerKey: string): string {
  return ASR_DISPLAY_MODEL_MAP[providerKey] || providerKey || 'unknown'
}

/** Whether an ASR provider may support live transcription, ignoring runtime prerequisites.
 * qwen3-asr-flash (qwen) is a non-streaming HTTP model; only qwen3-asr-flash-realtime
 * and Qwen Audio 3.1 support streaming among the Qwen providers. */
export function isStreamingDisplayCapable(provider: string): boolean {
  return provider === 'doubao_v2' || provider === 'qwen_realtime' || provider === 'qwen_audio_stream'
}

/**
 * Whether live transcription is ready for the current configuration, including runtime prerequisites.
 * - doubao_v2 is enabled directly; the server checks whether streaming ASR 2.0 is available.
 * - qwen_audio_stream (qwen-audio-3.1-asr-flash-streaming) does not require a workspace ID
 *   in this existing UI flow. The historical generic-host probe covered 3.0 only and is not
 *   a live check of 3.1.
 * - qwen_realtime (qwen3-asr-flash-realtime) requires a Beijing workspace ID for its regional endpoint.
 * - qwen (qwen3-asr-flash) is non-streaming and does not support live captions.
 */
export function isStreamingDisplayReady(provider: string, qwenWorkspaceId?: string): boolean {
  if (provider === 'doubao_v2') return true
  if (provider === 'qwen_audio_stream') return true
  if (provider === 'qwen_realtime') {
    return Boolean(qwenWorkspaceId && qwenWorkspaceId.trim())
  }
  return false
}

export function resolveCloudAsrLanguageRequest(provider: string, language: SpeechInputLanguage): string | undefined {
  if (provider === 'groq_whisper') return language === 'auto' ? undefined : language
  if (provider === 'mimo') return language === 'zh' || language === 'en' ? language : undefined
  return undefined
}

export function getCloudAsrSupportedLanguages(provider: string): SpeechInputLanguage[] | null {
  if (provider === 'groq_whisper') return ['ru', 'uk', 'en', 'zh']
  if (provider === 'mimo') return ['zh', 'en']
  return null
}

/**
 * Whether a model language list covers the selected speech language.
 * Returns null when there is nothing to badge: 'auto' lets the engine
 * detect the language, and a missing list means support is unknown.
 */
export function modelSupportsSpeechLanguage(
  languages: readonly string[] | undefined | null,
  language: SpeechInputLanguage,
): boolean | null {
  if (language === 'auto' || languages === undefined || languages === null) return null
  return languages.includes(language)
}

/**
 * Put models that support the requested language first without changing the
 * catalog order within each support group. Unknown metadata stays ahead of
 * models explicitly marked as unsupported.
 */
export function sortModelsBySpeechLanguageSupport<T extends { languages?: readonly string[] | null }>(
  models: readonly T[],
  language: Exclude<SpeechInputLanguage, 'auto'>,
): T[] {
  const supportRank = (support: boolean | null): number => {
    if (support === true) return 0
    if (support === null) return 1
    return 2
  }

  return models
    .map((model, index) => ({
      model,
      index,
      rank: supportRank(modelSupportsSpeechLanguage(model.languages, language)),
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ model }) => model)
}

/**
 * Display-only language for the compatibility badge: the selected speech
 * language, or — when it is 'auto' — the interface language mapped to an
 * ASR code. Never affects recognition; the engine still gets 'auto'.
 */
export function resolveBadgeLanguage(
  speechLanguage: SpeechInputLanguage,
  uiLocale: string,
): Exclude<SpeechInputLanguage, 'auto'> {
  if (speechLanguage !== 'auto') return speechLanguage
  if (uiLocale === 'uk') return 'uk'
  return 'en'
}

/**
 * Build the `extra` payload for a cloud ASR request. Omni providers carry the
 * resolved model ID plus system-prompt instructions; explicit-language providers
 * (Groq, MiMo) carry the language code; every other provider needs no payload.
 */
export function buildCloudAsrExtra(
  provider: string,
  language: SpeechInputLanguage,
  omniInstructions?: string,
  selectedModel?: string,
): Record<string, unknown> | undefined {
  if (isQwenOmniProvider(provider)) {
    return { model: resolveQwenOmniModel(provider), instructions: omniInstructions }
  }
  if (provider === 'openai_transcribe' || provider === 'gemini_transcribe' || provider === 'openrouter_transcribe') {
    return {
      ...(selectedModel ? { model: selectedModel } : {}),
      ...(language === 'auto' ? {} : { language }),
    }
  }
  const requestLanguage = resolveCloudAsrLanguageRequest(provider, language)
  return requestLanguage ? { language: requestLanguage } : undefined
}

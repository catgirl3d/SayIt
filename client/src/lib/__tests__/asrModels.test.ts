import { describe, it, expect } from 'vitest'
import * as asrModels from '../asrModels'
import {
  buildCloudAsrExtra,
  getCloudAsrSupportedLanguages,
  isQwenOmniProvider,
  modelSupportsSpeechLanguage,
  resolveBadgeLanguage,
  resolveCloudAsrLanguageRequest,
  resolveQwenOmniModel,
  resolveAsrDisplayModel,
  sortModelsBySpeechLanguageSupport,
} from '../asrModels'

describe('isQwenOmniProvider', () => {
  it('识别 Qwen Omni 系列', () => {
    expect(isQwenOmniProvider('qwen_omni_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_flash')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_38_realtime')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_flash')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_turbo')).toBe(true)
  })

  it('非 Omni 返回 false', () => {
    expect(isQwenOmniProvider('doubao_v2')).toBe(false)
    expect(isQwenOmniProvider('qwen')).toBe(false)
    expect(isQwenOmniProvider('')).toBe(false)
  })
})

describe('resolveQwenOmniModel', () => {
  it('返回正确的模型 ID', () => {
    expect(resolveQwenOmniModel('qwen_omni_35_plus')).toBe('qwen3.5-omni-plus-realtime')
    expect(resolveQwenOmniModel('qwen_omni_35_flash')).toBe('qwen3.5-omni-flash-realtime')
    expect(resolveQwenOmniModel('qwen_omni_38_realtime')).toBe('qwen3.8-omni-flash-realtime')
    expect(resolveQwenOmniModel('qwen_omni_flash')).toBe('qwen3-omni-flash-realtime')
    expect(resolveQwenOmniModel('qwen_omni_turbo')).toBe('qwen-omni-turbo-realtime')
  })

  it('非 Omni 返回 undefined', () => {
    expect(resolveQwenOmniModel('doubao_v2')).toBeUndefined()
    expect(resolveQwenOmniModel('qwen')).toBeUndefined()
  })
})

describe('resolveAsrDisplayModel', () => {
  it('映射已知供应商', () => {
    expect(resolveAsrDisplayModel('doubao_v2')).toBe('Doubao-Seed-ASR-2.0')
    expect(resolveAsrDisplayModel('qwen')).toBe('qwen3-asr-flash')
    expect(resolveAsrDisplayModel('qwen_audio_stream')).toBe('qwen-audio-3.1-asr-flash-streaming')
    expect(resolveAsrDisplayModel('mimo')).toBe('mimo-v2.5-asr')
    expect(resolveAsrDisplayModel('groq_whisper')).toBe('whisper-large-v3-turbo')
    expect(resolveAsrDisplayModel('qwen_omni_35_plus')).toBe('qwen3.5-omni-plus-realtime')
    expect(resolveAsrDisplayModel('qwen_omni_38_realtime')).toBe('qwen3.8-omni-flash-realtime')
  })

  it('未知供应商返回原始 key', () => {
    expect(resolveAsrDisplayModel('custom_provider')).toBe('custom_provider')
  })

  it('空字符串返回 unknown', () => {
    expect(resolveAsrDisplayModel('')).toBe('unknown')
  })
})

describe('cloud ASR language capabilities', () => {
  it('resolves explicit language requests by provider', () => {
    expect(resolveCloudAsrLanguageRequest('groq_whisper', 'auto')).toBeUndefined()
    expect(resolveCloudAsrLanguageRequest('groq_whisper', 'ru')).toBe('ru')
    expect(resolveCloudAsrLanguageRequest('mimo', 'zh')).toBe('zh')
    expect(resolveCloudAsrLanguageRequest('mimo', 'ru')).toBeUndefined()
    for (const provider of ['doubao_v2', 'qwen', 'qwen_realtime', 'qwen_omni_plus']) {
      for (const language of ['auto', 'ru', 'uk', 'en', 'zh'] as const) {
        expect(resolveCloudAsrLanguageRequest(provider, language)).toBeUndefined()
      }
    }
  })

  it('reports provider-supported explicit languages', () => {
    expect(getCloudAsrSupportedLanguages('groq_whisper')).toEqual(['ru', 'uk', 'en', 'zh'])
    expect(getCloudAsrSupportedLanguages('mimo')).toEqual(['zh', 'en'])
    expect(getCloudAsrSupportedLanguages('qwen')).toBeNull()
  })
})

describe('modelSupportsSpeechLanguage', () => {
  it('returns null for auto: the engine detects the language itself', () => {
    expect(modelSupportsSpeechLanguage(['ru', 'en'], 'auto')).toBeNull()
    expect(modelSupportsSpeechLanguage([], 'auto')).toBeNull()
    expect(modelSupportsSpeechLanguage(null, 'auto')).toBeNull()
  })

  it('matches the model language list exactly', () => {
    expect(modelSupportsSpeechLanguage(['ru', 'uk', 'en', 'zh'], 'ru')).toBe(true)
    expect(modelSupportsSpeechLanguage(['zh', 'en'], 'ru')).toBe(false)
  })

  it('returns null for a missing list: support is unknown, not absent', () => {
    expect(modelSupportsSpeechLanguage(null, 'ru')).toBeNull()
    expect(modelSupportsSpeechLanguage(undefined, 'ru')).toBeNull()
  })

  it('treats an empty list as supporting nothing', () => {
    expect(modelSupportsSpeechLanguage([], 'en')).toBe(false)
  })
})

describe('sortModelsBySpeechLanguageSupport', () => {
  it('puts supported models first and preserves order within support groups', () => {
    const models = [
      { id: 'unsupported-first', languages: ['en'] },
      { id: 'unknown', languages: null },
      { id: 'supported-first', languages: ['ru'] },
      { id: 'supported-second', languages: ['ru'] },
      { id: 'unsupported-second', languages: [] },
    ]
    const original = [...models]

    const ordered = sortModelsBySpeechLanguageSupport(models, 'ru')

    expect(ordered.map((model) => model.id)).toEqual([
      'supported-first',
      'supported-second',
      'unknown',
      'unsupported-first',
      'unsupported-second',
    ])
    expect(models).toEqual(original)
  })
})

describe('resolveBadgeLanguage', () => {
  it('prefers the selected speech language', () => {
    expect(resolveBadgeLanguage('ru', 'uk')).toBe('ru')
    expect(resolveBadgeLanguage('en', 'zh-CN')).toBe('en')
  })

  it('falls back to the interface language when speech is auto', () => {
    expect(resolveBadgeLanguage('auto', 'zh-CN')).toBe('en')
    expect(resolveBadgeLanguage('auto', 'uk')).toBe('uk')
    expect(resolveBadgeLanguage('auto', 'en')).toBe('en')
  })
})

describe('buildCloudAsrExtra', () => {
  it('omni providers carry the resolved model and instructions, never a language code', () => {
    const omniExtra = buildCloudAsrExtra('qwen_omni_35_flash', 'ru')
    expect(omniExtra).toEqual({ model: 'qwen3.5-omni-flash-realtime', instructions: undefined })
    expect(omniExtra).not.toHaveProperty('language')
  })

  it('routes the 3.8 Omni provider with one exact realtime suffix', () => {
    expect(buildCloudAsrExtra('qwen_omni_38_realtime', 'uk', 'Keep the transcript faithful.')).toEqual({
      model: 'qwen3.8-omni-flash-realtime',
      instructions: 'Keep the transcript faithful.',
    })
  })

  it('explicit-language providers carry the resolved language code', () => {
    expect(buildCloudAsrExtra('groq_whisper', 'ru', undefined, 'whisper-large-v3')).toEqual({
      model: 'whisper-large-v3',
      language: 'ru',
    })
    expect(buildCloudAsrExtra('groq_whisper', 'auto', undefined, 'whisper-large-v3')).toEqual({
      model: 'whisper-large-v3',
    })
    expect(buildCloudAsrExtra('groq_whisper', 'ru')).toEqual({ language: 'ru' })
    expect(buildCloudAsrExtra('groq_whisper', 'auto')).toBeUndefined()
    expect(buildCloudAsrExtra('mimo', 'zh')).toEqual({ language: 'zh' })
    expect(buildCloudAsrExtra('mimo', 'uk')).toBeUndefined()
  })

  it('keeps language capability unknown for buffered providers while sending selected hints', () => {
    const providers = ['openai_transcribe', 'gemini_transcribe', 'openrouter_transcribe']
    for (const provider of providers) {
      expect(getCloudAsrSupportedLanguages(provider)).toBeNull()
    }
    expect(buildCloudAsrExtra('openai_transcribe', 'uk', undefined, 'gpt-transcribe')).toEqual({
      model: 'gpt-transcribe',
      language: 'uk',
    })
    expect(buildCloudAsrExtra('openrouter_transcribe', 'auto', undefined, 'openai/gpt-transcribe')).toEqual({
      model: 'openai/gpt-transcribe',
    })
  })

  it('providers without explicit language support get no extra payload', () => {
    for (const provider of ['doubao_v2', 'qwen', 'qwen_realtime']) {
      for (const language of ['auto', 'ru', 'uk', 'en', 'zh'] as const) {
        expect(buildCloudAsrExtra(provider, language)).toBeUndefined()
      }
    }
  })

  it('sends the selected buffered model and explicit language, omitting auto', () => {
    expect(buildCloudAsrExtra('openai_transcribe', 'uk', undefined, 'gpt-4o-transcribe')).toEqual({
      model: 'gpt-4o-transcribe',
      language: 'uk',
    })
    expect(buildCloudAsrExtra('gemini_transcribe', 'auto', undefined, 'gemini-3.5-transcribe')).toEqual({
      model: 'gemini-3.5-transcribe',
    })
    expect(buildCloudAsrExtra('openrouter_transcribe', 'zh', undefined, 'qwen/qwen3-asr-1.7b')).toEqual({
      model: 'qwen/qwen3-asr-1.7b',
      language: 'zh',
    })
    expect(buildCloudAsrExtra('openai_compat', 'uk', undefined, 'local-audio-model')).toEqual({
      model: 'local-audio-model',
      language: 'uk',
    })
  })

  it('encodes custom provider and model together in the existing history provider field', () => {
    expect(asrModels.formatCustomAsrHistoryProvider('local-whisper')).toBe('openai_compat:local-whisper')
  })
})

import { describe, it, expect } from 'vitest'
import { buildCloudAsrExtra, getCloudAsrSupportedLanguages, isQwenOmniProvider, modelSupportsSpeechLanguage, resolveBadgeLanguage, resolveCloudAsrLanguageRequest, resolveQwenOmniModel, resolveAsrDisplayModel } from '../asrModels'

describe('isQwenOmniProvider', () => {
  it('识别 Qwen Omni 系列', () => {
    expect(isQwenOmniProvider('qwen_omni_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_plus')).toBe(true)
    expect(isQwenOmniProvider('qwen_omni_35_flash')).toBe(true)
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
    expect(resolveAsrDisplayModel('mimo')).toBe('mimo-v2.5-asr')
    expect(resolveAsrDisplayModel('qwen_omni_35_plus')).toBe('qwen3.5-omni-plus-realtime')
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

describe('resolveBadgeLanguage', () => {
  it('prefers the selected speech language', () => {
    expect(resolveBadgeLanguage('ru', 'uk')).toBe('ru')
    expect(resolveBadgeLanguage('en', 'zh-CN')).toBe('en')
  })

  it('falls back to the interface language when speech is auto', () => {
    expect(resolveBadgeLanguage('auto', 'zh-CN')).toBe('zh')
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

  it('explicit-language providers carry the resolved language code', () => {
    expect(buildCloudAsrExtra('groq_whisper', 'ru')).toEqual({ language: 'ru' })
    expect(buildCloudAsrExtra('groq_whisper', 'auto')).toBeUndefined()
    expect(buildCloudAsrExtra('mimo', 'zh')).toEqual({ language: 'zh' })
    expect(buildCloudAsrExtra('mimo', 'uk')).toBeUndefined()
  })

  it('providers without explicit language support get no extra payload', () => {
    for (const provider of ['doubao_v2', 'qwen', 'qwen_realtime']) {
      for (const language of ['auto', 'ru', 'uk', 'en', 'zh'] as const) {
        expect(buildCloudAsrExtra(provider, language)).toBeUndefined()
      }
    }
  })
})

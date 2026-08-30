import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeState = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}))

vi.mock('@/services/bridge', () => ({
  storeGet: vi.fn(async (key: string) => bridgeState.values.get(key) ?? null),
  storeSet: vi.fn(async (key: string, value: unknown) => {
    bridgeState.values.set(key, value)
  }),
}))

import { initLocaleDefaults } from '../language'

describe('首次运行的地区默认值', () => {
  beforeEach(() => bridgeState.values.clear())

  it('英文环境使用官方 Hugging Face 与 OpenAI-compatible', async () => {
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('HuggingFace')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('openai_compat')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('en')
  })

  it('Chinese environments keep domestic services while defaulting prompts to English', async () => {
    await initLocaleDefaults('zh-CN')
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('HuggingFace Mirror')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('deepseek')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('en')
  })

  it('keeps a legacy Chinese built-in override associated with Chinese prompts', async () => {
    bridgeState.values.set('promptPresets', [{ id: 'intent', systemPrompt: 'Legacy Chinese prompt' }])

    await initLocaleDefaults('en')

    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('zh-CN')
  })

  it('keeps an explicit English choice when a legacy Chinese override exists', async () => {
    bridgeState.values.set('ai.builtinPromptLanguage', 'en')
    bridgeState.values.set('promptPresets', [{ id: 'intent', systemPrompt: 'Legacy Chinese prompt' }])

    await initLocaleDefaults('zh-CN')

    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('en')
  })

  it('已有设置不会被界面语言覆盖', async () => {
    bridgeState.values.set('localAsr.downloadSource', 'Custom source')
    bridgeState.values.set('cloudAi.provider', '')
    bridgeState.values.set('ai.builtinPromptLanguage', 'zh-CN')
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('Custom source')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('zh-CN')
  })
})

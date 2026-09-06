import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridgeState = vi.hoisted(() => ({
  values: new Map<string, unknown>(),
}))

vi.mock('@/services/bridge', () => ({
  storeGet: vi.fn(async (key: string) => bridgeState.values.get(key) ?? null),
  storeSet: vi.fn(async (key: string, value: unknown) => {
    bridgeState.values.set(key, value)
  }),
  getSystemUiLanguage: vi.fn(async () => 'zh-CN'),
}))

import { initLanguage, initLocaleDefaults } from '../language'

describe('首次运行的地区默认值', () => {
  beforeEach(() => bridgeState.values.clear())

  it('英文环境使用官方 Hugging Face 与 OpenAI-compatible', async () => {
    await initLocaleDefaults('en')
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('HuggingFace')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('openai_compat')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('en')
  })

  it('Ukrainian environments do not receive China-specific defaults', async () => {
    await initLocaleDefaults('uk')
    expect(bridgeState.values.get('localAsr.downloadSource')).toBe('HuggingFace')
    expect(bridgeState.values.get('cloudAi.provider')).toBe('openai_compat')
    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('uk')
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

describe('UI language migration', () => {
  beforeEach(() => bridgeState.values.clear())

  it('maps a persisted Chinese UI preference to English', async () => {
    bridgeState.values.set('ui.language', 'zh-CN')

    await expect(initLanguage()).resolves.toBe('en')
  })

  it('maps a Chinese system UI language to English in auto mode', async () => {
    bridgeState.values.set('ui.language', 'auto')

    await expect(initLanguage()).resolves.toBe('en')
  })
})

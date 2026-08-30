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

import { getDefault } from '../defaults'
import {
  BUILTIN_PRESETS,
  builtinPromptContentHash,
  getBuiltinPromptLanguage,
  getBuiltinPromptPresets,
  getPromptPresets,
  normalizeBuiltinPromptLanguage,
  savePromptPreset,
  setBuiltinPromptLanguage,
  type PromptPreset,
} from '../store'

describe('Built-in prompt language', () => {
  beforeEach(() => bridgeState.values.clear())

  it('defaults to English while preserving an explicit Chinese choice', async () => {
    expect(getDefault('ai.builtinPromptLanguage')).toBe('en')
    expect(normalizeBuiltinPromptLanguage('zh-CN')).toBe('zh-CN')
    expect(normalizeBuiltinPromptLanguage('en')).toBe('en')
    expect(normalizeBuiltinPromptLanguage('uk')).toBe('uk')
    for (const value of ['', 'zh', 'en-US', 'uk-UA', null, undefined, 1]) {
      expect(normalizeBuiltinPromptLanguage(value), String(value)).toBe('en')
    }
    expect(await getBuiltinPromptLanguage()).toBe('en')

    bridgeState.values.set('ai.builtinPromptLanguage', 'zh-CN')
    expect(await getBuiltinPromptLanguage()).toBe('zh-CN')
  })

  it('all built-in languages provide the same ordered preset definitions', () => {
    const zh = getBuiltinPromptPresets('zh-CN')
    const en = getBuiltinPromptPresets('en')
    const uk = getBuiltinPromptPresets('uk')

    expect(zh.map((preset) => preset.id)).toEqual(BUILTIN_PRESETS.map((preset) => preset.id))
    expect(en.map((preset) => preset.id)).toEqual(zh.map((preset) => preset.id))
    expect(uk.map((preset) => preset.id)).toEqual(zh.map((preset) => preset.id))
    expect(en).toHaveLength(6)
    for (let index = 0; index < en.length; index += 1) {
      expect(en[index].systemPrompt.trim()).not.toBe('')
      expect(uk[index].systemPrompt.trim()).not.toBe('')
      expect(en[index].systemPrompt).not.toBe(zh[index].systemPrompt)
      expect(uk[index].systemPrompt).not.toBe(en[index].systemPrompt)
      expect(uk[index].systemPrompt).not.toBe(zh[index].systemPrompt)
      expect(en[index].builtinPromptLanguage).toBe('en')
      expect(zh[index].builtinPromptLanguage).toBe('zh-CN')
      expect(uk[index].builtinPromptLanguage).toBe('uk')
    }
    expect(uk.find((preset) => preset.id === 'translate_uk')?.systemPrompt).toContain('перекладач на українську мову')
    expect(uk.find((preset) => preset.id === 'translate_uk')?.systemPrompt).toContain('український текст')
    expect(uk.find((preset) => preset.id === 'translate_ru')?.systemPrompt).toContain('перекладач на російську мову')
    expect(uk.find((preset) => preset.id === 'translate_en')?.systemPrompt).toContain('перекладач на англійську мову')
  })

  it('loads presets according to persisted language selection', async () => {
    await setBuiltinPromptLanguage('uk')
    const presets = await getPromptPresets()

    expect(bridgeState.values.get('ai.builtinPromptLanguage')).toBe('uk')
    expect(presets.every((preset) => !preset.builtin || preset.builtinPromptLanguage === 'uk')).toBe(true)
  })

  it('built-in overrides remain isolated across all supported languages', async () => {
    const zhIntent = getBuiltinPromptPresets('zh-CN')[0]
    const enIntent = getBuiltinPromptPresets('en')[0]
    const ukIntent = getBuiltinPromptPresets('uk')[0]

    await savePromptPreset({ ...zhIntent, systemPrompt: '中文自定义 Prompt' })
    await savePromptPreset({ ...enIntent, systemPrompt: 'Custom English prompt' })
    await savePromptPreset({ ...ukIntent, systemPrompt: 'Custom Ukrainian prompt' })

    const stored = bridgeState.values.get('promptPresets') as PromptPreset[]
    expect(stored.find((preset) => preset.builtinPromptLanguage === 'zh-CN')?.builtinPromptBaseHash)
      .toBe(builtinPromptContentHash(zhIntent.systemPrompt))
    expect(stored.find((preset) => preset.builtinPromptLanguage === 'en')?.builtinPromptBaseHash)
      .toBe(builtinPromptContentHash(enIntent.systemPrompt))
    expect(stored.find((preset) => preset.builtinPromptLanguage === 'uk')?.builtinPromptBaseHash)
      .toBe(builtinPromptContentHash(ukIntent.systemPrompt))

    expect((await getPromptPresets('zh-CN'))[0].systemPrompt).toBe('中文自定义 Prompt')
    expect((await getPromptPresets('en'))[0].systemPrompt).toBe('Custom English prompt')
    expect((await getPromptPresets('uk'))[0].systemPrompt).toBe('Custom Ukrainian prompt')

    await savePromptPreset(zhIntent)
    expect((await getPromptPresets('zh-CN'))[0].systemPrompt).toBe(zhIntent.systemPrompt)
    expect((await getPromptPresets('en'))[0].systemPrompt).toBe('Custom English prompt')
    expect((await getPromptPresets('uk'))[0].systemPrompt).toBe('Custom Ukrainian prompt')
  })

  it('migrates legacy overrides without language field to Chinese', async () => {
    const legacyOverride: PromptPreset = {
      id: 'intent',
      name: '旧名称',
      systemPrompt: '旧中文 Prompt',
    }
    bridgeState.values.set('promptPresets', [legacyOverride])

    expect((await getPromptPresets('zh-CN'))[0].systemPrompt).toBe(legacyOverride.systemPrompt)
    expect((await getPromptPresets('zh-CN'))[0].builtinPromptModified).toBe(true)
    expect((await getPromptPresets('zh-CN'))[0].builtinPromptUpdateAvailable).toBe(false)
    expect((await getPromptPresets('en'))[0].systemPrompt)
      .toBe(getBuiltinPromptPresets('en')[0].systemPrompt)
    expect((await getPromptPresets('uk'))[0].systemPrompt)
      .toBe(getBuiltinPromptPresets('uk')[0].systemPrompt)
  })

  it('indicates update available when baseline differs from current definition', async () => {
    bridgeState.values.set('promptPresets', [{
      id: 'intent',
      name: 'Intent cleanup',
      systemPrompt: 'My customized prompt',
      builtinPromptLanguage: 'en',
      builtinPromptBaseHash: 'older-version',
    } satisfies PromptPreset])

    const preset = (await getPromptPresets('en'))[0]
    expect(preset.builtinPromptModified).toBe(true)
    expect(preset.builtinPromptUpdateAvailable).toBe(true)
  })

  it('cleans up legacy snapshots identical to official definitions on read', async () => {
    const current = getBuiltinPromptPresets('zh-CN')[0]
    bridgeState.values.set('promptPresets', [{
      id: current.id,
      name: '旧名称',
      systemPrompt: current.systemPrompt,
    } satisfies PromptPreset])

    const presets = await getPromptPresets('zh-CN')
    expect(presets[0].builtinPromptModified).toBeUndefined()
    expect(bridgeState.values.get('promptPresets')).toEqual([])
  })
})

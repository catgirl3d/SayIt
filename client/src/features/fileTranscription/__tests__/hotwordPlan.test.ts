import { describe, expect, it } from 'vitest'
import type { HotwordCatalog } from '@/services/hotwords/settings'
import { buildHotwordPlan, type HotwordCategorySelection } from '../hotwordPlan'

const catalog: HotwordCatalog = {
  builtinSetWords: { ai: ['GPT', 'Claude'], code: ['Git', 'Claude'] },
  builtinSetActive: { ai: true, code: false },
  customThemes: [{ id: 'mine', name: 'Mine', words: ['SayIt', 'GPT'] }],
  customThemeActive: { mine: false },
  activeWords: ['GPT', 'Claude'],
}

const noSelection: HotwordCategorySelection = { builtinKeys: [], themeIds: [] }

function plan(overrides: Partial<Parameters<typeof buildHotwordPlan>[0]> = {}) {
  return buildHotwordPlan({
    mode: 'active',
    selection: noSelection,
    catalog,
    engine: 'cloud',
    provider: 'qwen',
    providerDelivery: 'sent',
    providerClientCap: null,
    deepgramKeytermsEnabled: false,
    ...overrides,
  })
}

describe('buildHotwordPlan', () => {
  it('uses the active hotwords when the provider sends terms', () => {
    const result = plan()

    expect(result.applicable).toBe(true)
    expect(result.hotwords).toEqual(['GPT', 'Claude'])
    expect(result.tokenEstimate).toBeGreaterThan(0)
    expect(result.wordCount).toBe(2)
    expect(result.notices).toEqual([])
  })

  it('composes only the selected categories, including globally disabled ones', () => {
    const result = plan({ mode: 'selected', selection: { builtinKeys: ['code'], themeIds: ['mine'] } })

    expect(result.applicable).toBe(true)
    expect(result.hotwords).toEqual(['Git', 'Claude', 'SayIt', 'GPT'])
  })

  it('sends no words in the none mode while keeping the control available', () => {
    const result = plan({ mode: 'none' })

    expect(result.applicable).toBe(true)
    expect(result.hotwords).toEqual([])
    expect(result.wordCount).toBe(0)
    expect(result.notices).toEqual([])
  })

  it('does not silently fall back to the active hotwords when the catalog is unavailable', () => {
    expect(plan({ mode: 'active', catalog: null }).hotwords).toEqual([])
    expect(
      plan({ mode: 'selected', selection: { builtinKeys: ['ai'], themeIds: [] }, catalog: null }).hotwords,
    ).toEqual([])
  })

  it('hides the hotwords for the local engine', () => {
    const result = plan({ engine: 'local' })

    expect(result.applicable).toBe(false)
    expect(result.hotwords).toEqual([])
    expect(result.notices).toEqual([])
  })

  it('hides the hotwords when the provider does not send terms or its verdict is unknown', () => {
    for (const providerDelivery of ['not_sent', 'undecided'] as const) {
      const result = plan({ providerDelivery })

      expect(result.applicable, providerDelivery).toBe(false)
      expect(result.hotwords, providerDelivery).toEqual([])
      expect(result.notices, providerDelivery).toEqual([])
    }
  })

  it('warns when the Deepgram profile has not opted in to keyterms', () => {
    const result = plan({ provider: 'deepgram', deepgramKeytermsEnabled: false })

    expect(result.applicable).toBe(true)
    expect(result.notices).toEqual(['deepgramGate'])
  })

  it('warns that Deepgram sends nothing when the token budget is exceeded without a client cap', () => {
    const words = Array.from({ length: 501 }, (_, index) => `w${index}`)

    const result = plan({
      provider: 'deepgram',
      providerClientCap: null,
      deepgramKeytermsEnabled: true,
      catalog: { ...catalog, activeWords: words },
    })

    expect(result.notices).toEqual(['deepgramTokenBudget'])
    expect(result.wordCapLimit).toBeNull()
  })

  it('does not warn at the Deepgram token budget boundary', () => {
    // 100 ASCII words of 15 characters estimate to exactly 500 tokens (15 / 3 per word).
    const words = Array.from({ length: 100 }, (_, index) => `w${index}`.padEnd(15, 'x'))

    const result = plan({
      provider: 'deepgram',
      providerClientCap: null,
      deepgramKeytermsEnabled: true,
      catalog: { ...catalog, activeWords: words },
    })

    expect(result.tokenEstimate).toBe(500)
    expect(result.notices).toEqual([])
  })

  it('notes the provider client cap without Deepgram warnings for other providers', () => {
    const words = Array.from({ length: 101 }, (_, index) => `w${index}`)

    const result = plan({
      provider: 'gemini_transcribe',
      providerClientCap: 100,
      catalog: { ...catalog, activeWords: words },
    })

    expect(result.notices).toEqual(['wordCap'])
    expect(result.wordCapLimit).toBe(100)
  })

  it('does not warn at the provider client cap boundary', () => {
    const words = Array.from({ length: 100 }, (_, index) => `w${index}`)

    const result = plan({
      provider: 'gemini_transcribe',
      providerClientCap: 100,
      catalog: { ...catalog, activeWords: words },
    })

    expect(result.notices).toEqual([])
    expect(result.wordCapLimit).toBe(100)
  })
})

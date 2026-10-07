import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveAiProfiles } from '../aiProfileStore'
import type { AiProfile } from '../aiProviderCatalog'

const storedSettings = vi.hoisted(() => new Map<string, unknown>())

vi.mock('@/services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => storedSettings.get(key) ?? fallback),
  setSetting: vi.fn(async (key: string, value: unknown) => {
    storedSettings.set(key, structuredClone(value))
  }),
}))

beforeEach(() => {
  storedSettings.clear()
})

function profile(provider: string, over: Partial<AiProfile> = {}): AiProfile {
  return {
    id: `p-${provider}`,
    provider,
    apiUrl: 'https://example.test/v1',
    apiKey: 'sk-test',
    model: 'fixture-model',
    ...over,
  }
}

describe('runtime tuning mirror', () => {
  it('mirrors the active openai profile tuning into the flat runtime keys', async () => {
    const active = profile('openai', { reasoningEffort: 'low', serviceTier: 'fast' })

    await saveAiProfiles({ profiles: [active], activeId: active.id })

    expect(storedSettings.get('cloudAi.reasoningEffort')).toBe('low')
    expect(storedSettings.get('cloudAi.serviceTier')).toBe('fast')
  })

  it('mirrors reasoning effort but not service tier for opencode_go', async () => {
    const active = profile('opencode_go', { reasoningEffort: 'high', serviceTier: 'priority' })

    await saveAiProfiles({ profiles: [active], activeId: active.id })

    expect(storedSettings.get('cloudAi.reasoningEffort')).toBe('high')
    expect(storedSettings.get('cloudAi.serviceTier')).toBe('')
  })

  it('clears tuning keys when the active profile provider does not accept them', async () => {
    const stale = profile('deepseek', { reasoningEffort: 'high', serviceTier: 'priority' })

    await saveAiProfiles({ profiles: [stale], activeId: stale.id })

    expect(storedSettings.get('cloudAi.reasoningEffort')).toBe('')
    expect(storedSettings.get('cloudAi.serviceTier')).toBe('')
  })

  it('clears tuning keys when no profile is active', async () => {
    const active = profile('openai', { reasoningEffort: 'high', serviceTier: 'priority' })
    await saveAiProfiles({ profiles: [active], activeId: active.id })

    await saveAiProfiles({ profiles: [], activeId: '' })

    expect(storedSettings.get('cloudAi.reasoningEffort')).toBe('')
    expect(storedSettings.get('cloudAi.serviceTier')).toBe('')
  })
})

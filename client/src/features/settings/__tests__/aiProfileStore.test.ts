import { beforeEach, describe, expect, it, vi } from 'vitest'
import { saveAiProfiles } from '../aiProfileStore'
import * as bridge from '@/services/bridge'
import type { AiProfile } from '../aiProviderCatalog'

const storedSettings = vi.hoisted(() => new Map<string, unknown>())
const writeLog = vi.hoisted(() => [] as string[])
const writeGates = vi.hoisted(() => new Map<string, Promise<void>>())

async function writeSettings(settings: Record<string, unknown>) {
  writeLog.push(...Object.keys(settings))
  for (const key of Object.keys(settings)) {
    const gate = writeGates.get(key)
    if (gate) {
      writeGates.delete(key)
      await gate
    }
  }
  for (const [key, value] of Object.entries(settings)) storedSettings.set(key, structuredClone(value))
}

vi.mock('@/services/bridge', () => ({
  storeGet: vi.fn(async (key: string) => storedSettings.get(key) ?? null),
  storeSet: vi.fn(async (key: string, value: unknown) => writeSettings({ [key]: value })),
  storeSetAppSettings: vi.fn(async (settings: Record<string, unknown>) => writeSettings(settings)),
}))

beforeEach(() => {
  storedSettings.clear()
  writeLog.length = 0
  writeGates.clear()
  vi.clearAllMocks()
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

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

/** Wait for an observable event without depending on a fixed number of microtasks. */
async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error('condition was not reached')
}

describe('profile save serialization', () => {
  it('sends profiles, selection and all runtime fields through one native settings batch', async () => {
    const active = profile('openai', { reasoningEffort: 'low', serviceTier: 'fast' })

    await saveAiProfiles({ profiles: [active], activeId: active.id })

    expect(bridge.storeSetAppSettings).toHaveBeenCalledExactlyOnceWith({
      'cloudAi.profiles': [active],
      'cloudAi.activeProfileId': active.id,
      'cloudAi.provider': 'openai',
      'cloudAi.apiUrl': 'https://example.test/v1',
      'cloudAi.apiKey': 'sk-test',
      'cloudAi.model': 'fixture-model',
      'cloudAi.reasoningEffort': 'low',
      'cloudAi.serviceTier': 'fast',
    })
    expect(bridge.storeSet).not.toHaveBeenCalled()
  })

  /**
   * Regression: one save is a multi-key write. Two overlapping saves used to interleave,
   * pairing the list of one with the active ID of the other and mirroring the wrong
   * runtime profile.
   */
  it('does not start a second save while the first one is still writing', async () => {
    const gate = deferred()
    writeGates.set('cloudAi.profiles', gate.promise)
    const first = profile('deepseek', { id: 'p-first' })
    const second = profile('openai', { id: 'p-second' })

    const firstSave = saveAiProfiles({ profiles: [first], activeId: first.id })
    await until(() => writeLog.includes('cloudAi.profiles'))
    const secondSave = saveAiProfiles({ profiles: [second], activeId: second.id })
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(writeLog.filter((key) => key === 'cloudAi.profiles')).toHaveLength(1)
      expect(writeLog.filter((key) => key === 'cloudAi.activeProfileId')).toHaveLength(1)
    } finally {
      gate.resolve()
      await Promise.all([firstSave, secondSave])
    }

    expect(writeLog.filter((key) => key === 'cloudAi.profiles')).toHaveLength(2)
    expect(storedSettings.get('cloudAi.activeProfileId')).toBe(second.id)
  })

  it('keeps accepting saves after a failed write instead of wedging the queue', async () => {
    const failing = profile('deepseek', { id: 'p-fail' })
    const next = profile('openai', { id: 'p-next' })
    vi.mocked(bridge.storeSetAppSettings).mockRejectedValueOnce(new Error('disk full'))

    await expect(saveAiProfiles({ profiles: [failing], activeId: failing.id })).rejects.toThrow('disk full')

    await saveAiProfiles({ profiles: [next], activeId: next.id })

    expect(storedSettings.get('cloudAi.activeProfileId')).toBe(next.id)
  })
})

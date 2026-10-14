import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { UsageEventInput } from '@/types/usage'

const bridge = vi.hoisted(() => ({
  usageRecord: vi.fn(),
  usageSummary: vi.fn(),
  usageClear: vi.fn(),
  storeGet: vi.fn(),
  storeSet: vi.fn(),
}))

const nativeInvoke = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }))

vi.mock('../bridge', () => bridge)

import { clearStats, EMPTY_USAGE_SUMMARY, estimateTypingTimeSec, getSetting, getStats, recordUsage, setSetting } from '../store'

describe('native app settings batch', () => {
  it('uses the registered transaction command and propagates a failed commit', async () => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    const settings = { 'cloudAi.model': 'saved-model', 'cloudAi.apiKey': 'saved-key' }
    const failure = new Error('transaction failed')
    nativeInvoke.mockRejectedValueOnce(failure)

    await expect(actual.storeSetAppSettings(settings)).rejects.toBe(failure)

    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith('store_set_app_settings', { settings })
  })
})

describe('native usage commands', () => {
  beforeEach(() => {
    nativeInvoke.mockReset()
  })

  it('sends the dictation metadata to the registered usage command', async () => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    const event = {
      charCount: 40,
      durationSec: 2.5,
      appId: 'Code.exe',
      workMode: 'local',
      promptPresetId: 'intent',
    } satisfies UsageEventInput
    nativeInvoke.mockResolvedValue(undefined)

    await actual.usageRecord(event)

    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith('usage_record', { event })
  })

  it('propagates a failed native usage write', async () => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    const failure = new Error('database is locked')
    nativeInvoke.mockRejectedValue(failure)

    await expect(actual.usageRecord({ charCount: 8, durationSec: 1.5, workMode: 'local' }))
      .rejects.toBe(failure)
  })

  it.each([null, 1_000])('passes the cutoff %s to the native summary command', async (sinceMs) => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    const summary = { ...EMPTY_USAGE_SUMMARY, totalChars: 40, totalDurationSec: 2.5 }
    nativeInvoke.mockResolvedValue(summary)

    await expect(actual.usageSummary(sinceMs)).resolves.toEqual(summary)

    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith('usage_summary', { sinceMs })
  })

  it('clears statistics through the registered native usage command', async () => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    nativeInvoke.mockResolvedValue(undefined)

    await actual.usageClear()

    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith('usage_clear')
  })
})

describe('usage statistics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('records a dictation through the native usage log only', async () => {
    const event = { charCount: 40, durationSec: 2.5, appId: 'Code.exe', workMode: 'local', promptPresetId: 'intent' }
    bridge.usageRecord.mockResolvedValue(undefined)

    await recordUsage(event)

    expect(bridge.usageRecord).toHaveBeenCalledExactlyOnceWith(event)
    expect(bridge.storeGet).not.toHaveBeenCalled()
    expect(bridge.storeSet).not.toHaveBeenCalled()
  })

  it('reads the home totals from the all-time usage summary', async () => {
    bridge.usageSummary.mockResolvedValue({ ...EMPTY_USAGE_SUMMARY, totalChars: 320, totalDurationSec: 12.5 })

    await expect(getStats()).resolves.toEqual({ totalDurationSec: 12.5, totalChars: 320 })

    expect(bridge.usageSummary).toHaveBeenCalledExactlyOnceWith(null)
    expect(bridge.storeGet).not.toHaveBeenCalled()
  })

  it('clears statistics by clearing the usage log', async () => {
    bridge.usageClear.mockResolvedValue(undefined)

    await clearStats()

    expect(bridge.usageClear).toHaveBeenCalledTimes(1)
    expect(bridge.storeSet).not.toHaveBeenCalled()
  })
})

describe('usage summary sharing', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('shares one all-time read between home totals and the personalization profile', async () => {
    vi.resetModules()
    const store = await import('../store')
    const { getUserStats } = await import('../personalization/store')
    bridge.usageSummary.mockResolvedValue({
      ...store.EMPTY_USAGE_SUMMARY,
      takes: 9,
      totalChars: 1_000,
      totalDurationSec: 6,
      apps: [{ key: 'Code.exe', takes: 8, chars: 600 }],
      firstUsedAt: 1_000,
    })

    const [stats, profile] = await Promise.all([store.getStats(), getUserStats()])

    expect(stats).toEqual({ totalDurationSec: 6, totalChars: 1_000 })
    expect(profile).toEqual({
      totalWords: 600,
      totalSessions: 9,
      domainWords: { 'Code.exe': 600 },
      appUsageCount: { 'Code.exe': 8 },
      firstUsedAt: 1_000,
      lastUsedAt: undefined,
    })
    expect(bridge.usageSummary).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('retries a rejected shared summary so home and personalization can recover', async () => {
    vi.resetModules()
    const store = await import('../store')
    const { getUserStats } = await import('../personalization/store')
    const failure = new Error('database is locked')
    bridge.usageSummary.mockRejectedValueOnce(failure).mockResolvedValue({
      ...store.EMPTY_USAGE_SUMMARY,
      takes: 1,
      totalChars: 40,
      totalDurationSec: 2,
      apps: [{ key: 'Code.exe', takes: 1, chars: 40 }],
    })

    await expect(Promise.all([store.getUsageSummary(null), getUserStats()])).rejects.toBe(failure)
    expect(bridge.usageSummary).toHaveBeenCalledExactlyOnceWith(null)

    await expect(Promise.all([store.getStats(), getUserStats()])).resolves.toEqual([
      { totalDurationSec: 2, totalChars: 40 },
      {
        totalWords: 40,
        totalSessions: 1,
        domainWords: { 'Code.exe': 40 },
        appUsageCount: { 'Code.exe': 1 },
        firstUsedAt: undefined,
        lastUsedAt: undefined,
      },
    ])
    expect(bridge.usageSummary).toHaveBeenCalledTimes(2)
  })

  it('refreshes home and the real profile after a dictation and clears both without losing the first-use date', async () => {
    vi.resetModules()
    const store = await import('../store')
    const { getUserStats } = await import('../personalization/store')
    const lastUsedAt = new Date(2026, 9, 13, 15).getTime()
    const hourBuckets = new Array(24).fill(0)
    hourBuckets[15] = 1
    bridge.usageSummary
      .mockResolvedValueOnce({
        ...store.EMPTY_USAGE_SUMMARY,
        takes: 1,
        totalChars: 10,
        totalDurationSec: 1,
        apps: [{ key: 'Code.exe', takes: 1, chars: 10 }],
        firstUsedAt: 1_000,
      })
      .mockResolvedValueOnce({
        ...store.EMPTY_USAGE_SUMMARY,
        takes: 2,
        totalChars: 18,
        totalDurationSec: 2.5,
        datedTakes: 1,
        datedChars: 8,
        maxDurationSec: 1.5,
        activeDays: 1,
        hourBuckets,
        apps: [{ key: 'Code.exe', takes: 2, chars: 18 }],
        workModes: [{ key: 'local', takes: 1, chars: 8 }],
        promptPresets: [{ key: 'intent', takes: 1, chars: 8 }],
        firstUsedAt: 1_000,
        lastUsedAt,
      })
      .mockResolvedValueOnce({ ...store.EMPTY_USAGE_SUMMARY, firstUsedAt: 1_000 })
    bridge.usageRecord.mockResolvedValue(undefined)
    bridge.usageClear.mockResolvedValue(undefined)

    const [initialStats, initialProfile] = await Promise.all([store.getStats(), getUserStats()])
    expect(initialStats).toEqual({ totalDurationSec: 1, totalChars: 10 })
    expect(initialProfile.totalWords).toBe(10)
    expect(bridge.usageSummary).toHaveBeenCalledTimes(1)

    await store.recordUsage({ charCount: 8, durationSec: 1.5, appId: 'Code.exe', workMode: 'local', promptPresetId: 'intent' })
    const [updatedStats, updatedProfile] = await Promise.all([store.getStats(), getUserStats()])
    expect(updatedStats).toEqual({ totalDurationSec: 2.5, totalChars: 18 })
    expect(updatedProfile).toEqual({
      totalWords: 18,
      totalSessions: 2,
      domainWords: { 'Code.exe': 18 },
      appUsageCount: { 'Code.exe': 2 },
      firstUsedAt: 1_000,
      lastUsedAt,
    })
    expect(bridge.usageSummary).toHaveBeenCalledTimes(2)

    await store.clearStats()
    const [clearedStats, clearedProfile] = await Promise.all([store.getStats(), getUserStats()])
    expect(clearedStats).toEqual({ totalDurationSec: 0, totalChars: 0 })
    expect(clearedProfile).toEqual({
      totalWords: 0,
      totalSessions: 0,
      domainWords: {},
      appUsageCount: {},
      firstUsedAt: 1_000,
      lastUsedAt: undefined,
    })
    expect(bridge.usageSummary).toHaveBeenCalledTimes(3)
  })

  it('keeps range reads live instead of caching them', async () => {
    vi.resetModules()
    const store = await import('../store')
    bridge.usageSummary.mockResolvedValue(store.EMPTY_USAGE_SUMMARY)

    await store.getUsageSummary(1_000)
    await store.getUsageSummary(2_000)

    expect(bridge.usageSummary).toHaveBeenCalledTimes(2)
  })
})

describe('system-audio live recognition setting storage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('loads the saved opt-in and defaults missing values to off', async () => {
    bridge.storeGet.mockResolvedValueOnce(true).mockResolvedValueOnce(null)

    await expect(getSetting<boolean>('systemAudio.liveRecognitionEnabled')).resolves.toBe(true)
    await expect(getSetting<boolean>('systemAudio.liveRecognitionEnabled')).resolves.toBe(false)

    expect(bridge.storeGet).toHaveBeenNthCalledWith(1, 'systemAudio.liveRecognitionEnabled')
    expect(bridge.storeGet).toHaveBeenNthCalledWith(2, 'systemAudio.liveRecognitionEnabled')
  })

  it('persists only the dedicated system-audio opt-in key', async () => {
    await setSetting('systemAudio.liveRecognitionEnabled', true)

    expect(bridge.storeSet).toHaveBeenCalledTimes(1)
    expect(bridge.storeSet).toHaveBeenCalledWith('systemAudio.liveRecognitionEnabled', true)
  })
})

describe('estimateTypingTimeSec', () => {
  it('estimates equivalent typing duration at 50 words per minute', () => {
    expect(estimateTypingTimeSec(370)).toBe(89)
    expect(estimateTypingTimeSec(115)).toBe(28)
  })
})

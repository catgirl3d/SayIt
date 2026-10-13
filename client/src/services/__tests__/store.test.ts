import { beforeEach, describe, expect, it, vi } from 'vitest'

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
    vi.clearAllMocks()
  })

  it('shares one all-time read between home totals and the personalization profile', async () => {
    vi.resetModules()
    const store = await import('../store')
    bridge.usageSummary.mockResolvedValue({ ...store.EMPTY_USAGE_SUMMARY, totalChars: 120 })

    const [stats, profileSummary] = await Promise.all([store.getStats(), store.getUsageSummary(null)])

    expect(stats).toEqual({ totalDurationSec: 0, totalChars: 120 })
    expect(profileSummary.totalChars).toBe(120)
    expect(bridge.usageSummary).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('re-reads the all-time summary after a recorded dictation and after clearing statistics', async () => {
    vi.resetModules()
    const store = await import('../store')
    bridge.usageSummary.mockResolvedValue(store.EMPTY_USAGE_SUMMARY)
    bridge.usageRecord.mockResolvedValue(undefined)
    bridge.usageClear.mockResolvedValue(undefined)

    await store.getStats()
    expect(bridge.usageSummary).toHaveBeenCalledTimes(1)

    await store.recordUsage({ charCount: 8, durationSec: 1.5, appId: 'Code.exe', workMode: 'local', promptPresetId: 'intent' })
    await store.getStats()
    expect(bridge.usageSummary).toHaveBeenCalledTimes(2)

    await store.clearStats()
    await store.getStats()
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

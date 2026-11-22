import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => native.invoke(...args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))

import { setLocale } from '@/i18n'
import { DEFAULT_CUSTOM_WAVE, DEFAULT_WAVE_THEME } from '@/lib/overlayWaveColors'
import { OverlayService } from '../OverlayService'
import { OVERLAY_WIDTH_PRESET_VALUES, OVERLAY_WIDTH_PRESETS } from '../types'

interface RecordedUpdate {
  at: number
  data: Record<string, unknown>
}

let updates: RecordedUpdate[] = []

function gapsBetween(times: number[]) {
  return times.slice(1).map((time, index) => time - times[index])
}

function lastPcmUpdateIndex() {
  for (let index = updates.length - 1; index >= 0; index--) {
    if (Array.isArray(updates[index].data.bars)) return index
  }
  return -1
}

describe('overlay listening throttle', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setLocale('en')
    updates = []
    native.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'update_overlay_state') {
        updates.push({
          at: Date.now(),
          data: (args as { data: Record<string, unknown> }).data,
        })
      }
      return undefined
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('ticker alone publishes every 33 ms', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.startListeningTicker()

    await vi.advanceTimersByTimeAsync(330)
    overlay.stopListeningTicker()

    // One forced update at start, then one per 33 ms tick at 33, 66, ..., 330.
    expect(updates).toHaveLength(11)
    const gaps = gapsBetween(updates.map((update) => update.at))
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(33)
    }
  })

  it('ticker does not double up with the PCM path', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.startListeningTicker()

    for (let elapsed = 0; elapsed < 330; elapsed += 8) {
      overlay.pushListeningBars([1, 2, 3])
      await vi.advanceTimersByTimeAsync(8)
    }
    overlay.stopListeningTicker()

    const gaps = gapsBetween(updates.map((update) => update.at))
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(33)
    }
    expect(updates.length).toBeLessThanOrEqual(12)
    expect(updates.some((update) => Array.isArray(update.data.bars))).toBe(true)
  })

  it('ticker takes over when PCM stops', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.startListeningTicker()

    for (let elapsed = 0; elapsed < 100; elapsed += 8) {
      overlay.pushListeningBars([1, 2, 3])
      await vi.advanceTimersByTimeAsync(8)
    }
    const lastPcmIndex = lastPcmUpdateIndex()
    expect(lastPcmIndex).toBeGreaterThanOrEqual(0)
    const lastPcmAt = updates[lastPcmIndex].at

    await vi.advanceTimersByTimeAsync(200)
    overlay.stopListeningTicker()

    const afterPcm = updates.slice(lastPcmIndex + 1)
    expect(afterPcm.length).toBeGreaterThan(0)
    expect(afterPcm[0].at - lastPcmAt).toBeLessThanOrEqual(66)

    const gaps = gapsBetween(afterPcm.map((update) => update.at))
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(33)
    }
  })

  it('ticker updates carry the streaming text', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.setStreamingActive(true)
    overlay.setStreamingText('hello')
    overlay.startListeningTicker()

    await vi.advanceTimersByTimeAsync(66)
    overlay.stopListeningTicker()

    expect(updates[updates.length - 1].data).toMatchObject({
      state: 'listening',
      streaming: true,
      streamingText: 'hello',
    })
  })
})

describe('overlay listening payload settings', () => {
  let savedSettings: Record<string, unknown>

  beforeEach(() => {
    vi.useFakeTimers()
    setLocale('en')
    updates = []
    savedSettings = {}
    native.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'store_get') {
        return savedSettings[(args as { key: string }).key]
      }
      if (command === 'update_overlay_state') {
        updates.push({
          at: Date.now(),
          data: (args as { data: Record<string, unknown> }).data,
        })
      }
      return undefined
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('carries the theme and the normalized custom colors on a listening update', async () => {
    savedSettings = {
      overlayWaveTheme: 'custom',
      overlayWaveCustom: { mode: 'solid', from: '#22D3EE', to: '#f472b6' },
    }
    const overlay = new OverlayService(() => 7)
    await overlay.refreshSettings()
    overlay.pushListeningBars([3, 5, 8], true)

    expect(updates).toHaveLength(1)
    expect(updates[0].data).toMatchObject({
      state: 'listening',
      theme: 'custom',
      customWave: { mode: 'solid', from: '#22d3ee', to: '#f472b6' },
    })
  })

  it('sends the custom colors with a built-in theme too, so every payload is self-contained', async () => {
    savedSettings = {
      overlayWaveTheme: 'black-white',
      overlayWaveCustom: { mode: 'gradient', from: '#60a5fa', to: '#c084fc' },
    }
    const overlay = new OverlayService(() => 0)
    await overlay.refreshSettings()
    overlay.pushListeningBars([3], true)

    expect(updates[0].data).toMatchObject({
      theme: 'black-white',
      customWave: { mode: 'gradient', from: '#60a5fa', to: '#c084fc' },
    })
  })

  it('falls back to the normalized default colors when the saved custom colors are garbage', async () => {
    savedSettings = {
      overlayWaveTheme: 'custom',
      overlayWaveCustom: { mode: 'neon', from: 'red', to: 42 },
    }
    const overlay = new OverlayService(() => 0)
    await overlay.refreshSettings()
    overlay.pushListeningBars([3], true)

    expect(updates[0].data.customWave).toEqual(DEFAULT_CUSTOM_WAVE)
  })

  it('falls back to the app default theme for an unknown saved theme', async () => {
    savedSettings = { overlayWaveTheme: 'neon' }
    const overlay = new OverlayService(() => 0)
    await overlay.refreshSettings()
    overlay.pushListeningBars([3], true)

    expect(updates[0].data.theme).toBe(DEFAULT_WAVE_THEME)
  })

  it('sends the saved customWave on every frame while the settings are unchanged', async () => {
    savedSettings = { overlayWaveTheme: 'custom', overlayWaveCustom: { mode: 'solid', from: '#a3e635', to: '#000000' } }
    const overlay = new OverlayService(() => 0)
    await overlay.refreshSettings()
    overlay.pushListeningBars([3, 4], true)
    overlay.pushListeningBars([5, 6], true)

    expect(updates).toHaveLength(2)
    expect(updates[0].data.customWave).toEqual({ mode: 'solid', from: '#a3e635', to: '#000000' })
    expect(updates[1].data.customWave).toEqual({ mode: 'solid', from: '#a3e635', to: '#000000' })
  })

  it('uses every declared width preset and falls back to long for an unknown saved width', async () => {
    for (const preset of OVERLAY_WIDTH_PRESET_VALUES) {
      savedSettings = { overlayWidth: preset }
      const overlay = new OverlayService(() => 0)
      await overlay.refreshSettings()
      expect(overlay.getCommonPayload().barCount).toBe(OVERLAY_WIDTH_PRESETS[preset].barCount)
    }

    savedSettings = { overlayWidth: 'tiny' }
    const fallback = new OverlayService(() => 0)
    await fallback.refreshSettings()
    expect(fallback.getCommonPayload().barCount).toBe(OVERLAY_WIDTH_PRESETS.long.barCount)
  })
})

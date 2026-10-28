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
import { OverlayService } from '../OverlayService'

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

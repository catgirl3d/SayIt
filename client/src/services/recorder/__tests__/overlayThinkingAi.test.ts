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

function payloads() {
  return native.invoke.mock.calls
    .filter(([name]) => name === 'update_overlay_state')
    .map(([, args]) => (args as { data: Record<string, unknown> }).data)
}

function latestPayload() {
  const all = payloads()
  return all[all.length - 1]
}

describe('overlay AI processing indicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setLocale('en')
    native.invoke.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('marks the thinking payload when this run is AI-processed', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showThinking(3, 7, { ai: true })

    const payload = latestPayload()
    expect(payload?.state).toBe('thinking')
    expect(payload?.thinkingAi).toBe(true)
  })

  it('omits the flag on a tokenless showThinking call', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showThinking(3)

    expect(latestPayload()?.state).toBe('thinking')
    expect(latestPayload()).not.toHaveProperty('thinkingAi')
  })

  it('omits the flag when this run is not AI-processed', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showThinking(3, 1, { ai: false })

    expect(latestPayload()?.state).toBe('thinking')
    expect(latestPayload()).not.toHaveProperty('thinkingAi')
  })

  it('keeps the AI flag and the mic-source hint through the hint timer', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showMicSourceHint({ mode: 'fixed', label: 'USB Headset' })
    overlay.showThinking(3, 7, { ai: true })

    const thinking = latestPayload()
    expect(thinking?.state).toBe('thinking')
    expect(thinking?.thinkingAi).toBe(true)
    expect(thinking?.micSourceLabel).toBe('USB Headset')

    await vi.advanceTimersByTimeAsync(3_000)
    const latest = latestPayload()
    expect(latest?.state).toBe('thinking')
    expect(latest?.thinkingAi).toBe(true)
    expect(latest?.micSourceMode).toBeNull()
    expect(latest?.micSourceLabel).toBe('')
  })
})

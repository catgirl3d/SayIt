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

describe('overlay max-duration warning', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setLocale('en')
    native.invoke.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('keeps the processing presentation when the max-duration warning timer fires', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showTimeoutWarning()
    overlay.showThinking(3, 7, { ai: true })
    const marker = payloads().length

    await vi.advanceTimersByTimeAsync(4_000)

    expect(payloads().slice(marker).some((payload) => payload.state === 'listening')).toBe(false)
    expect(latestPayload()).toMatchObject({ state: 'thinking', thinkingAi: true })
    expect(overlay.hasStickyWarning()).toBe(false)
  })

  it('still hides the max-duration warning while listening', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.startListeningTicker(1)
    overlay.showTimeoutWarning()

    await vi.advanceTimersByTimeAsync(4_000)
    overlay.stopListeningTicker()

    expect(latestPayload()).toMatchObject({ state: 'listening', warning: '' })
  })
})

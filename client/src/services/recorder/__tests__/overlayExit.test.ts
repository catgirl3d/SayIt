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
import { OVERLAY_EXIT_HIDE_DELAY_MS, OverlayService } from '../OverlayService'

let savedSettings: Record<string, unknown> = {}

function payloads(command: 'present_overlay' | 'update_overlay_state') {
  return native.invoke.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => (args as { data: Record<string, unknown> }).data)
}

function latestPayload(command: 'present_overlay' | 'update_overlay_state') {
  const all = payloads(command)
  return all[all.length - 1]
}

function hideCount() {
  return native.invoke.mock.calls.filter(([name]) => name === 'hide_overlay').length
}

describe('overlay exit animation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setLocale('en')
    savedSettings = {}
    native.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'store_get') return savedSettings[(args as { key: string }).key]
      return undefined
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('flags a toast exit before hiding the window', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showCanceled()

    await vi.advanceTimersByTimeAsync(900)
    expect(hideCount()).toBe(0)
    expect(latestPayload('update_overlay_state')).toMatchObject({ state: 'toast', exit: true })

    await vi.advanceTimersByTimeAsync(OVERLAY_EXIT_HIDE_DELAY_MS)
    expect(hideCount()).toBe(1)
  })

  it('keeps the thinking state and the AI flag in the exit update', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showThinking(10, 1, { ai: true })

    void overlay.hide()

    expect(hideCount()).toBe(0)
    expect(latestPayload('update_overlay_state')).toMatchObject({
      state: 'thinking',
      thinkingAi: true,
      exit: true,
    })
  })

  it('lets a waiting presentation cancel a pending exit', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showCanceled()

    await vi.advanceTimersByTimeAsync(900)
    overlay.showWaiting()
    await vi.advanceTimersByTimeAsync(OVERLAY_EXIT_HIDE_DELAY_MS * 4)

    expect(hideCount()).toBe(0)
  })

  it('lets a subtitle presentation cancel a pending exit', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showCanceled()

    await vi.advanceTimersByTimeAsync(900)
    overlay.showSubtitles({
      subtitleText: '',
      subtitleStatus: '',
      subtitleError: '',
      subtitleNotice: '',
      subtitleSource: '',
    })
    await vi.advanceTimersByTimeAsync(OVERLAY_EXIT_HIDE_DELAY_MS * 4)

    expect(hideCount()).toBe(0)
  })

  it('hides immediately with interface animations off', async () => {
    savedSettings = { 'ui.animations': false }
    const overlay = new OverlayService(() => 0)
    await overlay.refreshSettings()
    overlay.showCanceled()

    await vi.advanceTimersByTimeAsync(900)

    expect(hideCount()).toBe(1)
    expect(payloads('update_overlay_state').some((payload) => payload.exit === true)).toBe(false)
  })

  it('hides immediately from listening', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showWaiting()
    overlay.startListeningTicker()
    const updatesBefore = payloads('update_overlay_state').length

    void overlay.hide()

    expect(hideCount()).toBe(1)
    expect(payloads('update_overlay_state')).toHaveLength(updatesBefore)
  })

  it('settles the superseded hide after the native hide, not before it', async () => {
    const nativeHideResolvers: Array<() => void> = []
    native.invoke.mockImplementation((command: string, args?: unknown) => {
      if (command === 'store_get') return Promise.resolve(savedSettings[(args as { key: string }).key])
      if (command === 'hide_overlay') {
        return new Promise<void>((resolve) => {
          nativeHideResolvers.push(resolve)
        })
      }
      return Promise.resolve(undefined)
    })
    const overlay = new OverlayService(() => 0)
    overlay.showCanceled()

    let firstSettled = false
    const first = overlay.hide().then(() => { firstSettled = true })
    let secondSettled = false
    const second = overlay.hide().then(() => { secondSettled = true })

    await Promise.resolve()
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    nativeHideResolvers[0]?.()
    await Promise.all([first, second])
    expect(firstSettled).toBe(true)
    expect(secondSettled).toBe(true)
  })
})

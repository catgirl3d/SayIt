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

import { setLocale, t } from '@/i18n'
import { OVERLAY_TOAST_WINDOW_WIDTH, OverlayService } from '../OverlayService'

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

describe('overlay toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setLocale('en')
    native.invoke.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('shows the preset-switch toast and auto-hides it after 1600ms', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showPresetSwitched('Fast')

    expect(payloads('present_overlay')).toHaveLength(1)
    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'toast',
      toastText: t('overlay.toastPresetSwitched', { name: 'Fast' }),
      toastTone: 'info',
    })

    await vi.advanceTimersByTimeAsync(1599)
    expect(hideCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(hideCount()).toBe(1)
  })

  it('keeps an expired toast timer from hiding a card presented later', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showAsrWarning()
    overlay.showCanceled()

    await vi.advanceTimersByTimeAsync(900)
    expect(hideCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(5000)
    expect(hideCount()).toBe(1)
  })

  it.each([
    ['timeout', 'overlay.toastAiCleanupTimeout'],
    ['provider_error', 'overlay.toastAiCleanupError'],
    ['empty_result', 'overlay.toastAiCleanupEmpty'],
    ['incomplete_profile', 'overlay.toastAiCleanupProfile'],
  ] as const)('shows the %s AI cleanup failure toast with its own reason', (reason, key) => {
    const overlay = new OverlayService(() => 0)
    overlay.showAiCleanupFailed(reason)

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'toast',
      toastText: t(key),
      toastTone: 'warn',
    })
  })

  it('appends the dictionary warning label and auto-hides the AI failure toast after 4000ms', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.showAiCleanupFailed('timeout', t('asr.deepgramKeytermLimitToast'))

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'toast',
      toastText: `${t('overlay.toastAiCleanupTimeout')} · ${t('asr.deepgramKeytermLimitToast')}`,
      toastTone: 'warn',
    })

    await vi.advanceTimersByTimeAsync(3999)
    expect(hideCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(hideCount()).toBe(1)
  })

  it('publishes the mic-source hint and drops it from the payload after 3000ms', async () => {
    const overlay = new OverlayService(() => 0)
    overlay.startListeningTicker()
    overlay.showMicSourceHint({ mode: 'fixed', label: 'USB Headset' })

    expect(latestPayload('update_overlay_state')).toMatchObject({
      state: 'listening',
      micSourceMode: 'fixed',
      micSourceLabel: 'USB Headset',
    })

    await vi.advanceTimersByTimeAsync(3000)
    expect(latestPayload('update_overlay_state')).toMatchObject({
      micSourceMode: null,
      micSourceLabel: '',
    })
  })

  it('sends the low-volume warning as an amber listening line', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showLowVolumeWarning()

    expect(latestPayload('update_overlay_state')).toMatchObject({
      state: 'listening',
      warning: t('overlay.warnLowVolume'),
      warningTone: 'warn',
    })
  })

  it('requests the expanded 600px base width for toasts to prevent clipping long notices', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showAiCleanupFailed('provider_error')

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'toast',
      baseWidth: OVERLAY_TOAST_WINDOW_WIDTH,
    })
  })

  it('requests the expanded 600px base width for error notices', () => {
    const overlay = new OverlayService(() => 0)
    overlay.showError('Audio capture failed')

    expect(latestPayload('present_overlay')).toMatchObject({
      state: 'error',
      baseWidth: OVERLAY_TOAST_WINDOW_WIDTH,
      errorMessage: 'Audio capture failed',
    })
  })
})

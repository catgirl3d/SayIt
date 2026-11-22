// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  refreshOverlaySettings: vi.fn(),
  setStreamingDisplayCache: vi.fn(),
}))

vi.mock('@/services/store', () => ({
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
  setSetting: (...args: unknown[]) => mocks.setSetting(...args),
}))

vi.mock('@/services/recorder', () => ({
  refreshOverlaySettings: (...args: unknown[]) => mocks.refreshOverlaySettings(...args),
  setStreamingDisplayCache: (...args: unknown[]) => mocks.setStreamingDisplayCache(...args),
}))

vi.mock('@tauri-apps/plugin-shell', () => ({ open: vi.fn() }))

import AppearancePage from '../AppearancePage'

const SAVED_CUSTOM_WAVE = { mode: 'solid', from: '#60a5fa', to: '#f472b6' }

/** The page reads its settings asynchronously; the custom editor appears only after the saved custom theme is applied. */
async function renderCustomWavePage() {
  render(<AppearancePage />)
  await screen.findByRole('button', { name: '#60A5FA' })
}

beforeEach(() => {
  mocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => {
    if (key === 'overlayWaveTheme') return 'custom'
    if (key === 'overlayWaveCustom') return SAVED_CUSTOM_WAVE
    return fallback
  })
  mocks.setSetting.mockReset().mockResolvedValue(undefined)
  mocks.refreshOverlaySettings.mockReset().mockResolvedValue(undefined)
  mocks.setStreamingDisplayCache.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('AppearancePage custom wave saving', () => {
  it('coalesces rapid color changes and writes only the latest value after the debounce', async () => {
    await renderCustomWavePage()

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(screen.getByRole('button', { name: '#F472B6' }))
    fireEvent.click(screen.getByRole('button', { name: '#A78BFA' }))

    await vi.advanceTimersByTimeAsync(249)
    expect(mocks.setSetting).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.setSetting).toHaveBeenCalledTimes(1)
    expect(mocks.setSetting).toHaveBeenCalledWith('overlayWaveCustom', {
      mode: 'solid',
      from: '#a78bfa',
      to: '#f472b6',
    })
  })

  it('flushes a pending color change when the page unmounts', async () => {
    const view = render(<AppearancePage />)
    await screen.findByRole('button', { name: '#60A5FA' })

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    fireEvent.click(screen.getByRole('button', { name: '#A78BFA' }))
    expect(mocks.setSetting).not.toHaveBeenCalled()

    view.unmount()

    expect(mocks.setSetting).toHaveBeenCalledTimes(1)
    expect(mocks.setSetting).toHaveBeenCalledWith('overlayWaveCustom', {
      mode: 'solid',
      from: '#a78bfa',
      to: '#f472b6',
    })
  })
})

// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  clearStats: vi.fn(),
  refreshRecorderSettings: vi.fn(),
  emit: vi.fn(),
  statsListeners: [] as Array<() => void>,
  unlistenStats: vi.fn(),
}))

vi.mock('@/services/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/store')>()
  return {
    ...actual,
    getStats: (...args: unknown[]) => mocks.getStats(...args),
    clearStats: (...args: unknown[]) => mocks.clearStats(...args),
    getSetting: vi.fn(async (_key: string, fallback: unknown) => fallback),
  }
})

vi.mock('@/services/recorder', () => ({
  refreshRecorderSettings: (...args: unknown[]) => mocks.refreshRecorderSettings(...args),
}))

vi.mock('@/services/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bridge')>()
  return {
    ...actual,
    listen: (event: string, handler: () => void) => {
      if (event === 'stats-updated') mocks.statsListeners.push(handler)
      return Promise.resolve(mocks.unlistenStats)
    },
    emit: (...args: unknown[]) => mocks.emit(...args),
  }
})

vi.mock('@/services/notice', () => ({
  fetchActiveNotice: vi.fn().mockResolvedValue(null),
  dismissNotice: vi.fn(),
  isSafeHttpsUrl: () => false,
}))

import Home from '../Home'

function openClearDialog() {
  fireEvent.click(screen.getByRole('button', { name: t('home.clearStats') }))
  return screen.getByRole('dialog')
}

describe('clearing usage statistics', () => {
  beforeEach(() => {
    mocks.getStats.mockReset().mockResolvedValue({ totalDurationSec: 600, totalChars: 5000 })
    mocks.clearStats.mockReset().mockResolvedValue(undefined)
    mocks.refreshRecorderSettings.mockReset().mockResolvedValue(undefined)
    mocks.emit.mockReset().mockResolvedValue(undefined)
    mocks.statsListeners.length = 0
    mocks.unlistenStats.mockReset()
  })

  afterEach(() => {
    mocks.statsListeners.length = 0
    vi.restoreAllMocks()
  })

  it('marks totals unavailable instead of showing zero after a failed stats load', async () => {
    mocks.getStats.mockReset().mockRejectedValueOnce(new Error('statistics unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<Home />)

    await waitFor(() => expect(screen.getByText(t('home.statsUnavailable'))).toBeTruthy())
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.queryByText('0')).toBeNull()
    consoleError.mockRestore()
  })

  it('lists everything that will be deleted, what is kept, and that it cannot be undone', async () => {
    render(<Home />)
    await waitFor(() => expect(mocks.getStats).toHaveBeenCalled())

    const dialog = openClearDialog()
    for (const key of [
      'home.clearStatsItemTotals',
      'home.clearStatsItemUsage',
      'home.clearStatsItemProfile',
      'home.clearStatsKept',
      'home.clearStatsIrreversible',
    ] as const) {
      expect(within(dialog).getByText(t(key))).toBeTruthy()
    }
    // Enter or Space right after opening must not delete anything.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: t('common.cancel') }))
  })

  it('deletes only through the explicit delete button', async () => {
    render(<Home />)
    await waitFor(() => expect(mocks.getStats).toHaveBeenCalled())

    fireEvent.click(within(openClearDialog()).getByRole('button', { name: t('common.cancel') }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.clearStats).not.toHaveBeenCalled()
    expect(mocks.refreshRecorderSettings).not.toHaveBeenCalled()

    fireEvent.click(within(openClearDialog()).getByRole('button', { name: t('home.clearStatsConfirmButton') }))
    await waitFor(() => expect(mocks.clearStats).toHaveBeenCalledTimes(1))
  })

  it('updates the recorder cache only after the clear has committed', async () => {
    let resolveClear!: () => void
    mocks.clearStats.mockImplementation(() => new Promise<void>((resolve) => { resolveClear = resolve }))
    render(<Home />)
    await waitFor(() => expect(mocks.getStats).toHaveBeenCalled())

    fireEvent.click(within(openClearDialog()).getByRole('button', { name: t('home.clearStatsConfirmButton') }))
    await waitFor(() => expect(mocks.clearStats).toHaveBeenCalledTimes(1))
    expect(mocks.refreshRecorderSettings).not.toHaveBeenCalled()

    resolveClear()
    await waitFor(() => expect(mocks.refreshRecorderSettings).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.emit).toHaveBeenCalledWith('stats-updated'))
    expect(mocks.refreshRecorderSettings.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.emit.mock.invocationCallOrder[0])
  })

  it('shows zero totals after a successful clear even when stats-updated emission fails', async () => {
    let currentStats = { totalDurationSec: 120, totalChars: 12 }
    mocks.getStats.mockImplementation(async () => currentStats)
    mocks.clearStats.mockImplementation(async () => {
      currentStats = { totalDurationSec: 0, totalChars: 0 }
    })
    mocks.emit.mockRejectedValue(new Error('event bridge unavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<Home />)
    const timeStats = screen.getByText(t('home.statTotalTime')).parentElement!
    const charStats = screen.getByText(t('home.statChars')).parentElement!

    await waitFor(() => {
      expect(within(timeStats).getByText('2')).toBeTruthy()
      expect(within(charStats).getByText('12')).toBeTruthy()
    })

    fireEvent.click(within(openClearDialog()).getByRole('button', { name: t('home.clearStatsConfirmButton') }))

    await waitFor(() => {
      expect(within(timeStats).getByText('0')).toBeTruthy()
      expect(within(charStats).getByText('0')).toBeTruthy()
    })
    expect(mocks.emit).toHaveBeenCalledWith('stats-updated')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('updates visible totals when the stats-updated listener receives an event', async () => {
    let currentStats = { totalDurationSec: 120, totalChars: 12 }
    mocks.getStats.mockImplementation(async () => currentStats)

    render(<Home />)
    const charStats = screen.getByText(t('home.statChars')).parentElement!
    await waitFor(() => expect(within(charStats).getByText('12')).toBeTruthy())
    await waitFor(() => expect(mocks.statsListeners).toHaveLength(1))

    currentStats = { totalDurationSec: 180, totalChars: 34 }
    for (const listener of mocks.statsListeners) listener()

    await waitFor(() => expect(within(charStats).getByText('34')).toBeTruthy())
    expect(within(charStats).queryByText('12')).toBeNull()
  })

  it('does not let an older stats response overwrite a newer event refresh', async () => {
    let resolveInitial!: (stats: { totalDurationSec: number; totalChars: number }) => void
    let resolveNewer!: (stats: { totalDurationSec: number; totalChars: number }) => void
    mocks.getStats
      .mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveNewer = resolve }))

    render(<Home />)
    const charStats = screen.getByText(t('home.statChars')).parentElement!
    await waitFor(() => expect(mocks.getStats).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.statsListeners).toHaveLength(1))

    for (const listener of mocks.statsListeners) listener()
    await waitFor(() => expect(mocks.getStats).toHaveBeenCalledTimes(2))

    resolveNewer({ totalDurationSec: 180, totalChars: 34 })
    await waitFor(() => expect(within(charStats).getByText('34')).toBeTruthy())

    await act(async () => {
      resolveInitial({ totalDurationSec: 120, totalChars: 12 })
      await Promise.resolve()
    })
    expect(within(charStats).getByText('34')).toBeTruthy()
    expect(within(charStats).queryByText('12')).toBeNull()
  })

  it('removes the stats-updated listener when Home unmounts', async () => {
    const { unmount } = render(<Home />)
    await waitFor(() => expect(mocks.statsListeners).toHaveLength(1))

    unmount()

    await waitFor(() => expect(mocks.unlistenStats).toHaveBeenCalledTimes(1))
  })

  it('reports a failed clear and leaves the recorder cache alone', async () => {
    mocks.clearStats.mockRejectedValue(new Error('database is locked'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Home />)
    await waitFor(() => expect(mocks.getStats).toHaveBeenCalled())

    const dialog = openClearDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: t('home.clearStatsConfirmButton') }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe(t('home.clearStatsError'))
    expect(mocks.refreshRecorderSettings).not.toHaveBeenCalled()
    expect(mocks.emit).not.toHaveBeenCalled()
    expect(screen.getByRole('dialog')).toBeTruthy()
    consoleError.mockRestore()
  })

  it('keeps the clear successful when the recorder cache refresh fails', async () => {
    mocks.refreshRecorderSettings.mockRejectedValue(new Error('recorder unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<Home />)
    await waitFor(() => expect(mocks.getStats).toHaveBeenCalled())

    fireEvent.click(within(openClearDialog()).getByRole('button', { name: t('home.clearStatsConfirmButton') }))
    await waitFor(() => expect(mocks.clearStats).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.refreshRecorderSettings).toHaveBeenCalledTimes(1))

    expect(screen.queryByRole('alert')).toBeNull()
    expect(mocks.emit).toHaveBeenCalledWith('stats-updated')
    consoleError.mockRestore()
  })
})

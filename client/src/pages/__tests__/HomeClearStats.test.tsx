// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'

const mocks = vi.hoisted(() => ({
  getStats: vi.fn(),
  clearStats: vi.fn(),
  refreshRecorderSettings: vi.fn(),
  emit: vi.fn(),
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
    listen: vi.fn().mockResolvedValue(() => undefined),
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

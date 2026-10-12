// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'

const mocks = vi.hoisted(() => ({
  listHistory: vi.fn(),
  countHistory: vi.fn(),
  clearHistory: vi.fn(),
  emit: vi.fn(),
}))

vi.mock('@/services/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/store')>()
  return {
    ...actual,
    listHistory: (...args: unknown[]) => mocks.listHistory(...args),
    countHistory: (...args: unknown[]) => mocks.countHistory(...args),
    clearHistory: (...args: unknown[]) => mocks.clearHistory(...args),
  }
})

vi.mock('@/services/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bridge')>()
  return {
    ...actual,
    listen: vi.fn().mockResolvedValue(() => undefined),
    emit: (...args: unknown[]) => mocks.emit(...args),
    readAudioFile: vi.fn(),
    deleteAudioFile: vi.fn(),
    getClientRuntimeInfo: vi.fn(),
  }
})

import History from '../History'

async function openClearDialog() {
  fireEvent.click(screen.getByRole('button', { name: t('history.clear') }))
  return screen.getByRole('dialog')
}

describe('history clearing', () => {
  beforeEach(() => {
    mocks.listHistory.mockReset().mockResolvedValue([])
    mocks.countHistory.mockReset().mockResolvedValue(0)
    mocks.clearHistory.mockReset().mockResolvedValue(undefined)
    mocks.emit.mockReset()
  })

  it('warns about the full deletion and keeps history intact when canceled', async () => {
    render(<History />)
    await waitFor(() => expect(mocks.listHistory).toHaveBeenCalled())

    const dialog = await openClearDialog()
    expect(within(dialog).getByText(t('history.clearConfirm'))).toBeTruthy()

    fireEvent.click(within(dialog).getByRole('button', { name: t('common.cancel') }))

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.clearHistory).not.toHaveBeenCalled()
  })

  it('clears only after confirmation, then reloads the list and refreshes stats', async () => {
    render(<History />)
    await waitFor(() => expect(mocks.listHistory).toHaveBeenCalledTimes(1))

    const dialog = await openClearDialog()
    expect(mocks.clearHistory).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: t('history.clear') }))

    await waitFor(() => expect(mocks.clearHistory).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(mocks.listHistory).toHaveBeenCalledTimes(2))
    expect(mocks.emit).toHaveBeenCalledWith('history-updated')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })

  it('shows the failure and keeps the dialog open when clearing fails', async () => {
    mocks.clearHistory.mockRejectedValue(new Error('database is locked'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<History />)
    await waitFor(() => expect(mocks.listHistory).toHaveBeenCalledTimes(1))

    const dialog = await openClearDialog()
    fireEvent.click(within(dialog).getByRole('button', { name: t('history.clear') }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toBe(t('history.clearError'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(mocks.listHistory).toHaveBeenCalledTimes(1)
    consoleError.mockRestore()
  })
})

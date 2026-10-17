// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'

const mocks = vi.hoisted(() => ({
  listHistory: vi.fn(),
  countHistory: vi.fn(),
  clearHistory: vi.fn(),
  exportHistory: vi.fn(),
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

vi.mock('@/services/exports', () => ({
  exportHistory: (...args: unknown[]) => mocks.exportHistory(...args),
}))

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
    mocks.exportHistory.mockReset().mockResolvedValue({ canceled: true, filePath: null })
    mocks.emit.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows a load error without claiming the history is empty, then restores records after retry', async () => {
    const record = {
      id: 'record-1',
      timestamp: Date.now(),
      asrText: 'recognized text',
      llmText: 'recognized text',
      asrMs: 10,
      llmMs: 0,
      durationSec: 1,
      charCount: 16,
    }
    mocks.listHistory.mockReset().mockRejectedValueOnce(new Error('history unavailable')).mockResolvedValueOnce([record])
    mocks.countHistory.mockReset().mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    render(<History />)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('history.loadError'))
    expect(screen.getByRole('button', { name: t('common.retry') })).toBeTruthy()
    expect(screen.queryByText(t('history.empty'))).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('common.retry') }))

    await waitFor(() => expect(screen.getAllByText('recognized text').length).toBeGreaterThan(0))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(t('history.empty'))).toBeNull()
  })

  it('reports an export failure and clears it after a successful retry', async () => {
    mocks.exportHistory.mockReset().mockRejectedValueOnce(new Error('export unavailable')).mockResolvedValueOnce({ canceled: true, filePath: null })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    render(<History />)
    await waitFor(() => expect(mocks.listHistory).toHaveBeenCalledTimes(1))

    fireEvent.click(screen.getByRole('button', { name: t('history.export') }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(t('history.exportError'))

    fireEvent.click(screen.getByRole('button', { name: t('history.export') }))

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(screen.getByText(t('history.exportCanceled'))).toBeTruthy()
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

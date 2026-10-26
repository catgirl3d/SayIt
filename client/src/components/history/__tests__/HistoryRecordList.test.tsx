// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale, t } from '@/i18n'
import { clearRuntimeEvents, getRuntimeEvents } from '@/services/debugLog'
import type { HistoryRecord } from '@/services/store'
import HistoryRecordList from '../HistoryRecordList'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id: 'record-1',
    timestamp: Date.now(),
    asrText: 'raw words',
    llmText: 'raw words',
    asrMs: 12,
    llmMs: 0,
    durationSec: 1,
    charCount: 9,
    workMode: 'cloud_api',
    ...overrides,
  }
}

describe('history AI execution mark', () => {
  afterEach(() => setLocale('en'))

  it('marks a failed AI stage instead of hiding the AI row', () => {
    setLocale('en')
    render(
      <HistoryRecordList
        records={[record({ aiSource: 'custom', aiStatus: 'failed', aiProvider: 'ollama', aiModel: 'qwen2.5:7b' })]}
        onDelete={() => undefined}
      />,
    )

    expect(screen.getByText(t('record.aiNotAppliedFailed'))).toBeTruthy()
    expect(screen.queryByText(/^AI: ollama/)).toBeNull()
  })

  it('keeps the applied provider row and shows no failure mark after a successful cleanup', () => {
    render(
      <HistoryRecordList
        records={[record({ aiSource: 'custom', aiStatus: 'applied', aiProvider: 'ollama', aiModel: 'qwen2.5:7b', llmMs: 25 })]}
        onDelete={() => undefined}
      />,
    )

    expect(screen.getByText(/^AI: ollama/)).toBeTruthy()
    expect(screen.queryByText(t('record.aiNotAppliedFailed'))).toBeNull()
  })

  it('keeps the legacy llmMs heuristic for records without an explicit status', () => {
    render(
      <HistoryRecordList
        records={[record({ aiProvider: 'ollama', aiModel: 'qwen2.5:7b', llmMs: 25 })]}
        onDelete={() => undefined}
      />,
    )

    expect(screen.getByText(/^AI: ollama/)).toBeTruthy()
    expect(screen.queryByText(t('record.aiNotAppliedFailed'))).toBeNull()
    expect(screen.queryByText(t('record.aiNotAppliedUnavailable'))).toBeNull()
  })
})

describe('history day groups', () => {
  afterEach(() => setLocale('en'))

  it('orders day headings by date, not by their localized text', () => {
    setLocale('en')
    render(
      <HistoryRecordList
        records={[
          record({ id: 'oct', timestamp: new Date(2026, 9, 1, 12).getTime(), asrText: 'newer' }),
          record({ id: 'sep', timestamp: new Date(2026, 8, 30, 12).getTime(), asrText: 'older' }),
        ]}
        onDelete={() => undefined}
      />,
    )

    const headings = screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)
    expect(headings).toEqual(['October 1, 2026', 'September 30, 2026'])
  })
})

describe('history rerun failures', () => {
  beforeEach(() => {
    setLocale('en')
    clearRuntimeEvents()
  })
  afterEach(() => setLocale('en'))

  async function startRerun(onReprocess: () => Promise<void>) {
    render(
      <HistoryRecordList
        records={[record({ audioFilePath: 'C:\\recordings\\one.wav' })]}
        onDelete={() => undefined}
        onReprocess={onReprocess}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: t('record.details') }))
    fireEvent.click(await screen.findByRole('button', { name: t('record.reprocess') }))
  }

  it('shows why a rerun failed and records the reason in the runtime log', async () => {
    await startRerun(() => Promise.reject('sayit_error:server_timeout:Retranscription timed out'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      t('record.reprocessFailed', { reason: 'Retranscription timed out' }),
    )
    const event = getRuntimeEvents().find((entry) => entry.message === 'Transcribe again failed')
    expect(event?.level).toBe('warn')
    expect(event?.detail).toEqual({
      recordId: 'record-1',
      error: 'Retranscription timed out',
    })
  })

  it.each([
    { label: 'an empty string', rejection: '' },
    { label: 'an empty envelope detail', rejection: 'sayit_error:server_timeout:' },
  ])('shows a fallback reason for $label', async ({ rejection }) => {
    await startRerun(() => Promise.reject(rejection))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(
      t('record.reprocessFailed', { reason: t('record.reprocessUnknown') }),
    )
  })
})

describe('history recording downloads', () => {
  beforeEach(() => {
    setLocale('en')
    invokeMock.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => setLocale('en'))

  function renderDownloadRecord() {
    const timestamp = new Date(2026, 9, 25, 10, 11, 12).getTime()
    const audioFilePath = 'C:\\recordings\\one.wav'
    const item = record({ timestamp, audioFilePath })
    render(<HistoryRecordList records={[item]} onDelete={() => undefined} />)
    fireEvent.click(screen.getByRole('button', { name: t('record.details') }))
    return { item, audioFilePath }
  }

  it('copies the recording directly with the generated flat filename', async () => {
    const { item, audioFilePath } = renderDownloadRecord()
    const savedPath = 'C:\\Users\\Storybook\\Downloads\\sayit_20261025_101112.wav'
    invokeMock.mockResolvedValueOnce(savedPath)

    fireEvent.click(await screen.findByRole('button', { name: t('record.downloadAudio') }))

    expect(invokeMock).toHaveBeenCalledWith('save_recording_to_downloads', {
      filePath: audioFilePath,
      fileName: 'sayit_20261025_101112.wav',
    })
    expect(invokeMock.mock.calls.some(([command]) => command === 'read_audio_file')).toBe(false)
    expect(invokeMock.mock.calls.some(([command]) => command === 'save_audio_to_downloads')).toBe(false)
    expect(item).toEqual(expect.objectContaining({ audioFilePath }))
    expect(await screen.findByText(t('record.savedTo', { path: savedPath }))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('record.openFolder') }))
    expect(invokeMock).toHaveBeenCalledWith('reveal_file_in_folder', { filePath: savedPath })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it.each([
    ['missing', 'record.downloadMissing'],
    ['invalid_name', 'record.downloadInvalidName'],
    ['already_exists', 'record.downloadAlreadyExists'],
    ['unreadable', 'record.downloadUnreadable'],
  ] as const)('shows a localized message for %s and leaves the record unchanged', async (errorCode, key) => {
    invokeMock.mockRejectedValueOnce(errorCode)
    const { item, audioFilePath } = renderDownloadRecord()
    const before = { ...item }

    fireEvent.click(await screen.findByRole('button', { name: t('record.downloadAudio') }))

    expect(await screen.findByText(t(key), { exact: false })).toBeTruthy()
    expect(item).toEqual(before)
    expect(invokeMock).toHaveBeenCalledWith('save_recording_to_downloads', {
      filePath: audioFilePath,
      fileName: 'sayit_20261025_101112.wav',
    })
  })
})

// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { setLocale, t } from '@/i18n'
import type { HistoryRecord } from '@/services/store'
import HistoryRecordList from '../HistoryRecordList'

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

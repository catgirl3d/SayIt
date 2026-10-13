import { describe, expect, it, vi } from 'vitest'

import {
  SubtitleTranscriptJournal,
  formatTranscriptEntry,
  transcriptFileName,
  type SubtitleTranscriptFragment,
} from '../subtitleTranscript'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function fragment(overrides: Partial<SubtitleTranscriptFragment> = {}): SubtitleTranscriptFragment {
  return {
    sequence: 1,
    startedAt: 0,
    original: 'Original speech',
    translation: null,
    untranslated: false,
    ...overrides,
  }
}

describe('formatTranscriptEntry', () => {
  it('writes the original and the translation on two lines with an indented translation', () => {
    const text = formatTranscriptEntry({
      elapsedMs: 754_000,
      original: 'hello there',
      translation: 'привет',
      untranslated: false,
      untranslatedMarker: '',
    })

    expect(text).toBe('[00:12:34] hello there\n           привет\n')
  })

  it('writes recognition-only fragments on one line without a marker', () => {
    const text = formatTranscriptEntry({
      elapsedMs: 3_000,
      original: 'raw recognition',
      translation: null,
      untranslated: false,
      untranslatedMarker: '(no translation)',
    })

    expect(text).toBe('[00:00:03] raw recognition\n')
  })

  it('appends the untranslated marker only for fragments marked as untranslated', () => {
    const text = formatTranscriptEntry({
      elapsedMs: 3_000,
      original: 'raw recognition',
      translation: null,
      untranslated: true,
      untranslatedMarker: '(no translation)',
    })

    expect(text).toBe('[00:00:03] raw recognition (no translation)\n')
  })

  it('collapses whitespace and newlines inside the texts so one fragment stays one block', () => {
    const text = formatTranscriptEntry({
      elapsedMs: 1_000,
      original: '  first\nline\tsecond  ',
      translation: 'перевод\t\tво второй\nстроке',
      untranslated: false,
      untranslatedMarker: '',
    })

    expect(text).toBe('[00:00:01] first line second\n           перевод во второй строке\n')
  })

  it('treats a blank translation as missing', () => {
    const text = formatTranscriptEntry({
      elapsedMs: 1_000,
      original: 'original',
      translation: '   ',
      untranslated: false,
      untranslatedMarker: '(no translation)',
    })

    expect(text).toBe('[00:00:01] original\n')
  })

  it('writes nothing when the original is blank', () => {
    expect(formatTranscriptEntry({
      elapsedMs: 1_000,
      original: '  \n ',
      translation: 'translation',
      untranslated: false,
      untranslatedMarker: '',
    })).toBe('')
  })

  it('clamps negative and non-finite elapsed values to zero', () => {
    const base = { original: 'text', translation: null, untranslated: false, untranslatedMarker: '' }
    expect(formatTranscriptEntry({ ...base, elapsedMs: -5_000 })).toBe('[00:00:00] text\n')
    expect(formatTranscriptEntry({ ...base, elapsedMs: Number.NaN })).toBe('[00:00:00] text\n')
    expect(formatTranscriptEntry({ ...base, elapsedMs: Number.POSITIVE_INFINITY })).toBe('[00:00:00] text\n')
  })

  it('truncates sub-second fractions and does not wrap hours at a day', () => {
    const base = { original: 'text', translation: null, untranslated: false, untranslatedMarker: '' }
    expect(formatTranscriptEntry({ ...base, elapsedMs: 59_999 })).toBe('[00:00:59] text\n')
    expect(formatTranscriptEntry({ ...base, elapsedMs: 360_005_000 })).toBe('[100:00:05] text\n')
  })
})

describe('transcriptFileName', () => {
  it('builds the file name from the local session start time', () => {
    const startedAt = new Date(2026, 9, 13, 16, 2, 11).getTime()
    expect(transcriptFileName(startedAt)).toBe('subtitles-2026-10-13_16-02-11.txt')
  })
})

describe('SubtitleTranscriptJournal', () => {
  function createJournal(options: {
    open?: (dir: string, name: string) => Promise<string>
    append?: (journalId: string, content: string) => Promise<void>
    close?: (journalId: string) => Promise<void>
  } = {}) {
    const onWriteError = vi.fn()
    const open = vi.fn(options.open ?? (async () => 'transcript-7'))
    const append = vi.fn(options.append ?? (async () => {}))
    const close = vi.fn(options.close ?? (async () => {}))
    const journal = new SubtitleTranscriptJournal({
      dir: 'C:/transcripts',
      startedAt: 1_000,
      untranslatedMarker: '(no translation)',
      onWriteError,
      open,
      append,
      close,
    })
    return { journal, open, append, close, onWriteError }
  }

  it('opens one backend journal and appends in order when fragments arrive before it opens', async () => {
    const openGate = deferred<string>()
    const { journal, open, append } = createJournal({ open: () => openGate.promise })

    journal.record(fragment({ sequence: 1, startedAt: 1_000, original: 'first', translation: 'prima' }))
    journal.record(fragment({ sequence: 2, startedAt: 4_000, original: 'second', translation: 'secunda' }))
    expect(open).toHaveBeenCalledTimes(0)
    expect(append).toHaveBeenCalledTimes(0)

    openGate.resolve('transcript-7')
    await journal.finish()

    expect(open).toHaveBeenCalledTimes(1)
    expect(open).toHaveBeenCalledWith('C:/transcripts', expect.stringMatching(/^subtitles-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.txt$/))
    expect(append.mock.calls).toEqual([
      ['transcript-7', '[00:00:00] first\n           prima\n'],
      ['transcript-7', '[00:00:03] second\n           secunda\n'],
    ])
  })

  it('appends the marker of a fragment without translation', async () => {
    const { journal, append } = createJournal()

    journal.record(fragment({ sequence: 1, startedAt: 1_000, original: 'heard only', untranslated: true }))
    await journal.finish()

    expect(append.mock.calls).toEqual([
      ['transcript-7', '[00:00:00] heard only (no translation)\n'],
    ])
  })

  it('reports one write error, stops recording and never opens a file when the journal cannot be created', async () => {
    const { journal, append, close, onWriteError } = createJournal({
      open: async () => { throw new Error('disk unavailable') },
    })

    journal.record(fragment({ sequence: 1 }))
    journal.record(fragment({ sequence: 2, original: 'later' }))
    await journal.finish()

    expect(onWriteError).toHaveBeenCalledTimes(1)
    expect(onWriteError).toHaveBeenCalledWith(expect.stringContaining('disk unavailable'))
    expect(append).toHaveBeenCalledTimes(0)
    expect(close).toHaveBeenCalledTimes(0)

    journal.record(fragment({ sequence: 3, original: 'after failure' }))
    await journal.finish()
    expect(onWriteError).toHaveBeenCalledTimes(1)
  })

  it('reports one write error, keeps written entries and still releases the backend journal when an append fails', async () => {
    const { journal, append, close, onWriteError } = createJournal({
      append: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('sharing violation'))
        .mockResolvedValue(undefined),
    })

    journal.record(fragment({ sequence: 1, original: 'first' }))
    journal.record(fragment({ sequence: 2, original: 'second' }))
    journal.record(fragment({ sequence: 3, original: 'third' }))
    await journal.finish()

    expect(append).toHaveBeenCalledTimes(2)
    expect(onWriteError).toHaveBeenCalledTimes(1)
    expect(onWriteError).toHaveBeenCalledWith(expect.stringContaining('sharing violation'))
    expect(close).toHaveBeenCalledExactlyOnceWith('transcript-7')
  })

  it('does not open a backend journal for a fragment that formats to nothing', async () => {
    const { journal, open, append } = createJournal()

    journal.record(fragment({ sequence: 1, original: '   ' }))
    await journal.finish()

    expect(open).toHaveBeenCalledTimes(0)
    expect(append).toHaveBeenCalledTimes(0)
  })

  it('writes fragments in sequence order even when they arrive out of order', async () => {
    const { journal, append } = createJournal()

    journal.record(fragment({ sequence: 2, original: 'second' }))
    for (let index = 0; index < 10; index++) await Promise.resolve()
    expect(append).toHaveBeenCalledTimes(0)

    journal.record(fragment({ sequence: 1, original: 'first' }))
    await journal.finish()

    expect(append.mock.calls.map(([, content]) => content)).toEqual([
      '[00:00:00] first\n',
      '[00:00:00] second\n',
    ])
  })

  it('ignores a duplicate of an already written fragment', async () => {
    const { journal, append } = createJournal()

    journal.record(fragment({ sequence: 1, original: 'once' }))
    journal.record(fragment({ sequence: 1, original: 'once' }))
    await journal.finish()

    expect(append).toHaveBeenCalledTimes(1)
  })

  it('finish writes fragments still waiting behind a missing sequence', async () => {
    const { journal, append } = createJournal()

    journal.record(fragment({ sequence: 2, original: 'orphan' }))
    await journal.finish()

    expect(append.mock.calls.map(([, content]) => content)).toEqual(['[00:00:00] orphan\n'])
  })

  it('finish waits for a pending append and releases the backend journal afterwards', async () => {
    const appendGate = deferred<void>()
    const { journal, append, close } = createJournal({ append: () => appendGate.promise })

    journal.record(fragment({ sequence: 1 }))
    let finished = false
    const finish = journal.finish().then(() => { finished = true })
    for (let index = 0; index < 10; index++) await Promise.resolve()
    expect(append).toHaveBeenCalledTimes(1)
    expect(finished).toBe(false)
    expect(close).toHaveBeenCalledTimes(0)

    appendGate.resolve()
    await finish
    expect(finished).toBe(true)
    expect(close).toHaveBeenCalledExactlyOnceWith('transcript-7')
  })

  it('finish resolves even when releasing the backend journal fails', async () => {
    const { journal, close } = createJournal({ close: async () => { throw new Error('registry gone') } })

    journal.record(fragment({ sequence: 1 }))
    await expect(journal.finish()).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledExactlyOnceWith('transcript-7')
  })
})

import * as bridge from './bridge'

// One fragment becomes one block: the original line, and — when the fragment was translated — an
// indented translation line right below it.
const INDENT = ' '.repeat('[00:00:00] '.length)

export interface SubtitleTranscriptEntry {
  /** Milliseconds from the journal's session start to the beginning of the recognized speech. */
  elapsedMs: number
  original: string
  /** Recognized translation, or null when the fragment has none (recognition-only mode). */
  translation: string | null
  /** True when the fragment produced no translation and the marker must explain that. */
  untranslated: boolean
  untranslatedMarker: string
}

/** One settled subtitle fragment, at the moment its text is final. */
export interface SubtitleTranscriptFragment {
  /** Speech-order number assigned to every fragment whose text is known; the file follows this order. */
  sequence: number
  /** Wall-clock time the recognized speech started on. */
  startedAt: number
  original: string
  translation: string | null
  untranslated?: boolean
}

export interface SubtitleTranscriptJournalOptions {
  /** Raw setting value; empty means the platform default directory resolved by the backend. */
  dir: string
  startedAt: number
  untranslatedMarker: string
  /** Called once when the journal cannot be written; the session keeps running without it. */
  onWriteError: (message: string) => void
  open?: (dir: string, name: string) => Promise<string>
  append?: (journalId: string, content: string) => Promise<void>
  close?: (journalId: string) => Promise<void>
}

const pad = (value: number) => String(value).padStart(2, '0')

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** `[HH:MM:SS]` — hours grow past 24 instead of wrapping; broken values count as zero. */
function transcriptClock(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1_000)) : 0
  const hours = Math.floor(seconds / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds % 60)}`
}

/** One journal block with a trailing newline, or '' when the fragment carries no original text. */
export function formatTranscriptEntry(entry: SubtitleTranscriptEntry): string {
  const original = normalizeText(entry.original)
  if (!original) return ''
  const line = `[${transcriptClock(entry.elapsedMs)}] ${original}`
  const translation = entry.translation === null ? '' : normalizeText(entry.translation)
  if (translation) return `${line}\n${INDENT}${translation}\n`
  const marker = entry.untranslated ? normalizeText(entry.untranslatedMarker) : ''
  return `${marker ? `${line} ${marker}` : line}\n`
}

/** `subtitles-YYYY-MM-DD_HH-mm-ss.txt` in local time. */
export function transcriptFileName(startedAt: number): string {
  const date = new Date(startedAt)
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`
  return `subtitles-${stamp}_${time}.txt`
}

/**
 * Append-only journal for one subtitle session. The backend creates the file lazily on the first
 * fragment and hands back an opaque journal id, so the frontend never addresses file paths. Writes are
 * serialized on one chain to keep the file order equal to the recognition order; a fragment whose
 * translation was dropped can arrive before an earlier one is still being translated, so entries wait
 * for their speech-order turn. After the first write error the journal reports it once and stops
 * recording, and the session continues without it.
 */
export class SubtitleTranscriptJournal {
  private readonly openFile: (dir: string, name: string) => Promise<string>
  private readonly appendFile: (journalId: string, content: string) => Promise<void>
  private readonly closeFile: (journalId: string) => Promise<void>
  private readonly fileName: string
  private chain: Promise<void> = Promise.resolve()
  private journalId: string | null = null
  private writeFailed = false
  private nextSequence = 1
  private readonly held = new Map<number, string>()

  constructor(private readonly options: SubtitleTranscriptJournalOptions) {
    this.openFile = options.open ?? ((dir, name) => bridge.createSubtitleTranscript(dir, name))
    this.appendFile = options.append ?? ((journalId, content) => bridge.appendSubtitleTranscript(journalId, content))
    this.closeFile = options.close ?? ((journalId) => bridge.closeSubtitleTranscript(journalId))
    this.fileName = transcriptFileName(options.startedAt)
  }

  /** Fire-and-forget; failures surface through `onWriteError` instead of rejecting the caller. */
  record(fragment: SubtitleTranscriptFragment): void {
    if (this.writeFailed || fragment.sequence < this.nextSequence) return
    const content = formatTranscriptEntry({
      elapsedMs: fragment.startedAt - this.options.startedAt,
      original: fragment.original,
      translation: fragment.translation,
      untranslated: fragment.untranslated === true,
      untranslatedMarker: this.options.untranslatedMarker,
    })
    this.held.set(fragment.sequence, content)
    while (this.held.has(this.nextSequence)) {
      const next = this.held.get(this.nextSequence)!
      this.held.delete(this.nextSequence)
      this.nextSequence += 1
      if (next) this.enqueueAppend(next)
    }
  }

  /** Waits for every accepted fragment, then releases the backend handle. Never rejects. */
  async finish(): Promise<void> {
    for (const sequence of [...this.held.keys()].sort((left, right) => left - right)) {
      const content = this.held.get(sequence)!
      this.held.delete(sequence)
      if (content) this.enqueueAppend(content)
    }
    await this.chain
    const journalId = this.journalId
    this.journalId = null
    if (journalId === null) return
    try {
      await this.closeFile(journalId)
    } catch {
      // Releasing the backend handle is cleanup only: there is nothing to retry against and every
      // stale handle disappears with the process, so a failed release must not fail the stop.
    }
  }

  private enqueueAppend(content: string): void {
    this.chain = this.chain.then(async () => {
      if (this.writeFailed) return
      if (this.journalId === null) this.journalId = await this.openFile(this.options.dir, this.fileName)
      await this.appendFile(this.journalId, content)
    }).catch((error: unknown) => {
      this.failWrite(error)
    })
  }

  private failWrite(error: unknown): void {
    if (this.writeFailed) return
    this.writeFailed = true
    this.options.onWriteError(String(error))
  }
}

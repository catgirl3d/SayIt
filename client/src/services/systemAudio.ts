import * as bridge from './bridge'
import { t } from '@/i18n'
import { getPromptPresets, getSetting, TRANSLATION_PRESET_PREFIX } from './store'
import { normalizeSpeechInputLanguage, type SpeechInputLanguage } from './speechInputLanguage'
import {
  DEFAULT_SEGMENT_SECONDS,
  FRAME_BYTES,
  FRAME_MS,
  normalizeSegmentSeconds,
  segmentPlan,
  SubtitleSegmenter,
  type SealedSubtitleSegment,
  type SegmentPlan,
  type SubtitleFrame,
} from './subtitleSegmentation'
import {
  LiveSpeechAccumulator,
  type LiveFinalizeRequest,
  type LiveFrameTiming,
  type LiveIdleTiming,
  type LiveRecognitionError,
} from './systemAudioLiveRecognition'
import { buildSubtitlePrompt, RecentSpeech, SUBTITLE_CONTEXT_SOURCE, subtitleLanguageName } from './subtitleTranslation'
import { SubtitleTranscriptJournal } from './subtitleTranscript'
import { addRuntimeEvent } from './debugLog'
import { describeProviderError } from '@/lib/errorMessages'
import {
  DEEPGRAM_KEYTERM_LIMIT,
  type AsrWarningCode,
  type FinalResult,
  type LiveAsrResult,
  type LiveAsrSession,
  type StartOptions,
  type TranscriptionProvider,
} from './transcription/types'
import {
  beginRun,
  countDiscontinuity,
  countFrame,
  failRun,
  finishRun,
  isPipelineDebugEnabled,
  markQueued,
  noteSpeechFrameGap,
  setPipelineActivity,
  setQueueDepth,
  type SegmentCloseReason,
} from './pipelineTrace'
import {
  acquireSystemAudio,
  hideSubtitleOverlay,
  presentSubtitleOverlay,
  releaseSystemAudio,
  assertLocalSystemAudioAdmission,
  updateSubtitleOverlay,
} from './recorder'
import { getProvider } from './transcription'
import { polishWithClientAi } from './transcription/clientAiPolish'
import { getRuntimeServerAiSource } from './transcription/serverAiSource'
import { loadActiveHotwords } from './hotwords/settings'
import type { SubtitleOverlayPayload } from './recorder/types'
import type { TextContext } from '@/types/appContext'

// Targets are owned by the builtin translate_* presets in store.ts; sessions validate them by preset id lookup.
export type SubtitleTargetLanguage = string
export type SystemAudioState = 'idle' | 'starting' | 'listening' | 'paused' | 'stopping' | 'error'

export interface SystemAudioSnapshot {
  state: SystemAudioState
  caption: string
  error: string
  warning: string
  /** Notice describing the current caption itself (e.g. that it is the untranslated original); shown in the overlay status line. */
  captionNotice: string
  /** Recognized original shown next to the translation in dual-subtitle mode; empty otherwise. */
  source: string
  liveOriginal: string
  liveRecognition: boolean
}

export interface SystemAudioDevice {
  id: string
  name: string
  isDefault: boolean
}

interface SystemAudioFrame extends LiveFrameTiming {
  sessionId: number
  audioB64: string
  speechProbability: number
  discontinuity: boolean
}

interface SystemAudioLiveIdle extends LiveIdleTiming {
  sessionId: number
}

interface SystemAudioCaptureTimingError {
  sessionId: number
  message: string
}

interface SessionDependencies {
  acquire: () => Promise<void>
  release: () => Promise<void>
  getProvider: () => TranscriptionProvider
  assertLocalAdmission?: () => void
  overlay: {
    present: (payload: SubtitleOverlayPayload) => Promise<number>
    update: (payload: SubtitleOverlayPayload) => Promise<void>
    hide: () => Promise<void>
  }
}

/** When a segment's speech started and ended, on the clock frames are received on. */
interface SegmentSpan {
  readonly startedAt: number
  readonly endedAt: number
}

interface SegmentJob extends SegmentSpan {
  audio: Uint8Array
  runId: number | null
}

/** One recognized segment waiting for, or undergoing, client-side translation. */
interface TranslationJob {
  readonly runId: number | null
  readonly asrText: string
  readonly asrMs: number
  readonly durationSec: number
  readonly speechMs: number
  readonly context?: TextContext
  readonly asrEngine?: string
  readonly asrModel?: string
  readonly phraseId?: number
  readonly sourceSpan?: SegmentSpan
  /** Speech-order number for the transcript journal; assigned when the fragment's text became final. */
  readonly journalSequence?: number
}

interface OverlayDelivery {
  generation: number
  payload: SubtitleOverlayPayload
  runId: number | null
  finishDetails?: PipelineFinishDetails
}

interface PipelineFinishDetails {
  asrMs: number
  llmMs: number
  asrEngine?: string
  asrModel?: string
  aiProvider?: string
  aiModel?: string
  asrChars: number
  captionChars: number
}

// After 5 seconds, annotate an unconfirmed stop so the UI explains the delay while cleanup continues.
const LIVE_STOP_WATCHDOG_MS = 5_000
// Bound queued PCM at 12 seconds (16,000 samples/s x 2 bytes x 12); drop the oldest speech when processing lags.
const MAX_PENDING_BYTES = 16_000 * 2 * 12
// Close the current speech segment after this receive inactivity interval.
// This is 512 ms, or 16 frame periods at FRAME_MS = 32 ms.
const FRAME_RECEIVE_GAP_MS = 512
// Abandon an ASR job after 30 seconds, cancel the provider, and report the fragment as skipped.
const PROCESSING_TIMEOUT_MS = 30_000
// One bad fragment (a slow or failing AI, a recognition error) is skipped or shown untranslated. The session
// stops only when this many fragments fail back to back, which means the service itself is down or misconfigured.
const MAX_CONSECUTIVE_FAILURES = 3
// Keep the latest settled caption visible for 8 seconds before clearing it unless a newer caption replaces it.
const CAPTION_HOLD_MS = 8_000
// A stalled transcript destination must not keep the session stopping forever; the unfinished write tail is dropped.
const JOURNAL_FLUSH_TIMEOUT_MS = 3_000
// Streamed translation text is repainted at most this often; the settled caption is always published.
const PARTIAL_UPDATE_INTERVAL_MS = 100
// Streamed partial translations are off. Repainting the settled caption with the growing prefix made the
// bottom panel collapse to a short line and grow back on every phrase, which reads as the caption jumping.
// This flag is the switch for that model streaming: when true, the native request streams partial text and
// the caption repaints as it arrives; when false, the translation lands whole.
const STREAM_SUBTITLE_TRANSLATIONS = false
// A flush answer normally lands within a few hundred milliseconds. When it is lost, the confirmed
// text is settled without it so captions keep moving; the advanced commit watermark keeps the late
// answer from publishing a second caption.
const LIVE_SETTLE_FALLBACK_MS = 1_000
// Every caption-bound field of the snapshot; reset together so a notice or original never outlives its caption.
const NO_CAPTION = { caption: '', captionNotice: '', source: '', liveOriginal: '' } as const
const NO_SETTLED_CAPTION = { caption: '', captionNotice: '', source: '' } as const
// Waiting translations are bounded by the same 12 s of speech as the audio queue: older fragments are dropped
// so captions never drift far behind the speech now playing.
const MAX_TRANSLATION_BACKLOG_MS = 12_000
let sequence = Date.now()

export async function getSystemAudioSourceLanguage(): Promise<SpeechInputLanguage> {
  return normalizeSpeechInputLanguage(await getSetting('systemAudio.sourceLanguage', 'auto'))
}

export async function getSystemAudioDualSubtitles(): Promise<boolean> {
  return (await getSetting('systemAudio.dualSubtitles', false)) === true
}

export async function getSystemAudioMaxSegmentSeconds(): Promise<number> {
  return normalizeSegmentSeconds(await getSetting('systemAudio.maxSegmentSec', DEFAULT_SEGMENT_SECONDS))
}

export function listSystemAudioDevices() {
  return bridge.invoke<SystemAudioDevice[]>('list_system_audio_devices')
}

/** Owns a passive listening session; it never runs dictation insertion or microphone policies. */
export class SystemAudioSession {
  constructor(private readonly dependencies: SessionDependencies) {}

  private snapshot: SystemAudioSnapshot = { state: 'idle', ...NO_CAPTION, liveRecognition: false, error: '', warning: '' }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private leased = false
  private provider: TranscriptionProvider | null = null
  private localModelId = ''
  private options: { deviceId: string; targetLanguage: SubtitleTargetLanguage; asrOnly: boolean } | null = null
  private startOptions: Omit<StartOptions, 'runId'> | null = null
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private liveCleanup: Promise<void> | null = null
  private liveRecovery: Promise<void> | null = null
  private captureId = 0
  private captureStop: Promise<void> = Promise.resolve()
  private captureStopId = 0
  private captureStartCompletion: Promise<void> | null = null
  private captureStartIssued = false
  private unlisteners: Array<() => void> = []
  private overlayInFlight: Promise<void> | null = null
  private pendingOverlay: OverlayDelivery | null = null
  private overlayFailure: unknown = null
  private plan: SegmentPlan = segmentPlan(DEFAULT_SEGMENT_SECONDS)
  private segmenter = new SubtitleSegmenter(this.plan)
  // Fixed per start: the overlay window is sized once, so the layout must not change under a running session.
  private dual = false
  private queue: SegmentJob[] = []
  private queuedBytes = 0
  private activeJob = 0
  private activeSpan: SegmentSpan | null = null
  private consecutiveFailures = 0
  private translations: TranslationJob[] = []
  private translationBacklogMs = 0
  private translating: TranslationJob | null = null
  private lastPartialAt = 0
  private activeContext: TextContext | undefined
  private activeSplit = false
  private readonly recent = new RecentSpeech()
  private asrWarning: AsrWarningCode | null = null
  private publishedAsrJob = 0
  private activeRunId: number | null = null
  private lastFrameAt = 0
  private gapTimer: ReturnType<typeof setTimeout> | null = null
  private processingTimer: ReturnType<typeof setTimeout> | null = null
  private captionTimer: ReturnType<typeof setTimeout> | null = null
  private liveSettleTimer: ReturnType<typeof setTimeout> | null = null
  private settledCaptionPhraseId: number | null = null
  private liveRequested = false
  private liveSelected = false
  private liveSession: LiveAsrSession | null = null
  private liveSessionId: string | null = null
  private liveAccumulator: LiveSpeechAccumulator | null = null
  /** The last non-empty original shown in the single-subtitle live panel; it stays until new speech replaces it. */
  private lastLiveOriginal = ''
  private liveDiscontinuityWarning = ''
  private journal: SubtitleTranscriptJournal | null = null
  private journalSequence = 0
  private freshStart = false

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(change: Partial<SystemAudioSnapshot>, runId?: number | null, finishDetails?: PipelineFinishDetails) {
    this.snapshot = { ...this.snapshot, ...change }
    this.listeners.forEach((listener) => listener())
    const traceRunId = runId !== undefined && runId !== null && finishDetails ? runId : null
    if (!this.leased) {
      if (traceRunId !== null && isPipelineDebugEnabled()) finishRun(traceRunId, { ...finishDetails, overlayMs: null })
      return
    }
    const pending = this.pendingOverlay
    if (pending?.runId !== null && pending?.runId !== undefined && pending.finishDetails && isPipelineDebugEnabled()) {
      finishRun(pending.runId, { ...pending.finishDetails, overlayMs: null })
    }
    this.pendingOverlay = {
      generation: this.generation,
      payload: this.overlayPayload(),
      runId: traceRunId,
      ...(finishDetails && { finishDetails }),
    }
    this.startOverlayPump()
  }

  private startOverlayPump() {
    if (this.overlayInFlight) return
    const operation = (async () => {
      while (this.pendingOverlay) {
        const delivery = this.pendingOverlay
        this.pendingOverlay = null
        let overlayMs: number | null = null
        if (delivery.generation === this.generation && this.leased) {
          const traceOverlay = delivery.runId !== null && isPipelineDebugEnabled()
          const overlayStartedAt = traceOverlay ? Date.now() : 0
          try {
            await this.dependencies.overlay.update(delivery.payload)
            // A later successful render supersedes an earlier update error for release purposes.
            this.overlayFailure = null
            if (traceOverlay) overlayMs = Math.max(0, Date.now() - overlayStartedAt)
          } catch (error) {
            this.overlayFailure = error
            if (delivery.runId !== null && isPipelineDebugEnabled()) failRun(delivery.runId, 'failed', String(error))
            continue
          }
        }
        if (delivery.runId !== null && delivery.finishDetails && isPipelineDebugEnabled()) {
          finishRun(delivery.runId, { ...delivery.finishDetails, overlayMs })
        }
      }
    })()
    this.overlayInFlight = operation
    void operation.finally(() => {
      if (this.overlayInFlight === operation) this.overlayInFlight = null
      if (this.pendingOverlay) this.startOverlayPump()
    })
  }

  private async awaitOverlayUpdates() {
    while (this.overlayInFlight || this.pendingOverlay) {
      if (!this.overlayInFlight) this.startOverlayPump()
      await this.overlayInFlight
    }
    if (this.overlayFailure !== null) {
      const failure = this.overlayFailure
      this.overlayFailure = null
      throw failure
    }
  }

  private overlayPayload(): SubtitleOverlayPayload {
    const payload: SubtitleOverlayPayload = {
      subtitleText: this.snapshot.caption,
      // The steady "listening" label only sits on top of the video; every other state is named, and a warning replaces it.
      subtitleStatus: this.snapshot.warning || (this.snapshot.state === 'listening' ? '' : t(`systemAudio.status.${this.snapshot.state}`)),
      subtitleError: this.snapshot.error,
      subtitleNotice: this.snapshot.captionNotice,
      subtitleSource: this.snapshot.source,
    }
    if (this.snapshot.liveRecognition) {
      payload.subtitleLiveText = this.snapshot.liveOriginal
      payload.subtitleLiveRecognition = true
    }
    return payload
  }

  private currentWarning(extra = '') {
    const warnings = [
      this.liveDiscontinuityWarning,
      this.asrWarning === DEEPGRAM_KEYTERM_LIMIT ? t('asr.deepgramKeytermLimitWarning') : '',
      extra,
    ].filter(Boolean)
    return warnings.join(' ')
  }

  // Single-subtitle live never blanks the live panel between phrases: while the service prepares the
  // translation, and until the next phrase starts streaming, the last recognized original stays on
  // screen. The panel clears only when the session resets (pause, stop, error), so it cannot flicker
  // off at every commit. Dual and recognition-only modes show the settled original below instead.
  private retainedLiveOriginal(text: string): string {
    if (this.dual || this.options?.asrOnly) return text
    if (text) this.lastLiveOriginal = text
    return text || this.lastLiveOriginal
  }

  /** The journal stopped for this session; subtitles keep running without it. */
  private reportJournalFailure(message: string): void {
    const warning = t('systemAudio.transcriptWriteFailed', { reason: message })
    this.publish({ warning: this.liveSelected ? this.currentWarning(warning) : warning })
    addRuntimeEvent('warn', 'system-audio', 'Subtitle transcript write failed; recording stopped', { message })
  }

  /** Journals a settled fragment outcome; the original is always recorded, with its translation when there is one. */
  private recordTranscriptOutcome(
    transcript: { sequence: number; span?: SegmentSpan } | undefined,
    original: string,
    translation: string | null,
    untranslated: boolean,
  ): void {
    if (!transcript || !this.journal) return
    this.journal.record({
      sequence: transcript.sequence,
      startedAt: transcript.span?.startedAt ?? Date.now(),
      original,
      translation,
      untranslated,
    })
  }

  /** Journals the recognized original of a fragment whose translation was dropped or cancelled. */
  private recordUnfinishedTranscript(job: Pick<TranslationJob, 'journalSequence' | 'sourceSpan' | 'asrText'>): void {
    if (job.journalSequence === undefined || !this.journal) return
    const original = job.asrText.trim()
    if (!original) return
    this.journal.record({
      sequence: job.journalSequence,
      startedAt: job.sourceSpan?.startedAt ?? Date.now(),
      original,
      translation: null,
      untranslated: true,
    })
  }

  private finishDetails(result: FinalResult, caption: string): PipelineFinishDetails {
    return {
      asrMs: result.asrMs,
      llmMs: result.llmMs,
      asrEngine: result.asrEngine ?? (this.provider?.mode === 'local' ? 'local' : undefined),
      asrModel: result.asrModel ?? (this.provider?.mode === 'local' ? this.localModelId : undefined),
      aiProvider: result.aiProvider,
      aiModel: result.aiModel,
      asrChars: result.asrText.length,
      captionChars: caption.length,
    }
  }

  // The outcome policy shared by the server-managed and client-AI paths: an absent translation is shown as
  // the recognized original with an untranslated notice and counts toward the failure streak; an applied
  // translation replaces the caption and pairs with its original in dual-subtitle mode. Returns false when
  // the session stopped and the caller must not continue.
  private publishTranslationOutcome(
    result: FinalResult,
    runId: number | null,
    generation: number,
    phraseId?: number,
    transcript?: { sequence: number; span?: SegmentSpan },
  ): boolean {
    const original = result.asrText.trim()
    const comparableTranslation = result.llmText.replace(/\s+/g, ' ').trim()
    const comparableSource = result.asrText.replace(/\s+/g, ' ').trim()
    if (result.aiStatus !== 'applied' || !comparableTranslation) {
      // The AI produced no translation. Show what was heard, marked as untranslated, and keep listening.
      failRun(runId, 'rejected', result.aiStatus !== 'applied' ? result.aiStatus : 'empty translation')
      this.recordTranscriptOutcome(transcript, original, null, true)
      if (this.recordFailure(t('systemAudio.translationFailed'))) return false
      this.publishCaption(original, generation, undefined, undefined, t('systemAudio.untranslated'), '', phraseId)
      return true
    }
    this.consecutiveFailures = 0
    const caption = result.llmText.trim()
    const traceRunId = isPipelineDebugEnabled() ? runId : null
    // A translation identical to the transcript is speech already in the target language, a name, a number,
    // or an AI echoing its input when its answer was empty. Never present it as a translation.
    const identical = comparableTranslation === comparableSource
    this.recordTranscriptOutcome(transcript, original, identical ? null : caption, identical)
    this.publishCaption(caption, generation, traceRunId, traceRunId === null ? undefined : this.finishDetails(result, caption),
      identical ? t('systemAudio.untranslated') : '', this.dual && !identical ? original : '', phraseId)
    return true
  }

  private publishCaption(caption: string, generation: number, runId?: number | null, finishDetails?: PipelineFinishDetails, captionNotice = '', source = '', phraseId?: number) {
    const warning = this.currentWarning()
    const change = { caption, warning, captionNotice, source }
    if (runId !== undefined && runId !== null && finishDetails) this.publish(change, runId, finishDetails)
    else this.publish(change)
    this.holdCaption(generation, phraseId)
  }

  // Dual-subtitle mode shows the recognized original while its translation is still pending. The previous caption is
  // dropped with it, so the original is never paired with the translation of the fragment before.
  private publishSource(source: string, generation: number) {
    this.publish({ caption: '', captionNotice: '', source })
    this.holdCaption(generation)
  }

  // Partial translations repaint the caption while the AI is still writing it. They never arm the hold timer:
  // a pending timer belongs to the caption being replaced, and only the settled outcome starts a new hold.
  private publishPartialTranslation(job: TranslationJob, text: string, generation: number): void {
    if (generation !== this.generation || this.translating !== job) return
    const partial = text.trim()
    if (!partial) return
    const now = Date.now()
    if (now - this.lastPartialAt < PARTIAL_UPDATE_INTERVAL_MS) return
    this.lastPartialAt = now
    if (this.captionTimer) {
      clearTimeout(this.captionTimer)
      this.captionTimer = null
    }
    this.publish({ caption: partial, captionNotice: '' })
  }

  private holdCaption(generation: number, phraseId?: number) {
    if (this.captionTimer) clearTimeout(this.captionTimer)
    this.settledCaptionPhraseId = phraseId ?? null
    this.captionTimer = setTimeout(() => {
      if (generation === this.generation && this.settledCaptionPhraseId === (phraseId ?? null)) {
        this.publish(NO_SETTLED_CAPTION)
        this.settledCaptionPhraseId = null
      }
    }, CAPTION_HOLD_MS)
  }

  async start(options: { deviceId: string; targetLanguage: SubtitleTargetLanguage; asrOnly?: boolean }): Promise<void> {
    if (this.snapshot.state !== 'idle') return
    this.options = { ...options, asrOnly: options.asrOnly ?? false }
    // A user start opens the optional transcript journal; pause, resume, and recovery keep it.
    this.freshStart = true
    await this.begin()
  }

  private async begin(reuseSnapshot = false, preserveWarnings = false) {
    const generation = ++this.generation
    if (!preserveWarnings) {
      this.asrWarning = null
      this.liveDiscontinuityWarning = ''
    }
    this.publish({
      state: 'starting',
      ...NO_CAPTION,
      liveRecognition: reuseSnapshot ? this.snapshot.liveRecognition : false,
      error: '',
      warning: preserveWarnings ? this.currentWarning() : '',
    })
    const operation = this.open(generation, reuseSnapshot)
    this.starting = operation
    try { await operation } finally { if (this.starting === operation) this.starting = null }
  }

  private async open(generation: number, reuseSnapshot = false) {
    try {
      if (!this.leased) {
        await this.dependencies.acquire()
        this.leased = true
      }
      if (generation !== this.generation) return
      const asrOnly = this.options!.asrOnly
      if (!reuseSnapshot) {
        const [presets, language, hotwords, maxSegmentSeconds, dual, liveRecognitionEnabled, transcriptEnabled, transcriptDir] = await Promise.all([
          asrOnly ? Promise.resolve([]) : getPromptPresets(),
          getSystemAudioSourceLanguage(),
          loadActiveHotwords(),
          getSystemAudioMaxSegmentSeconds(),
          getSystemAudioDualSubtitles(),
          getSetting('systemAudio.liveRecognitionEnabled', false),
          getSetting('systemAudio.transcriptEnabled', false),
          getSetting<string>('systemAudio.transcriptDir', ''),
        ])
        if (generation !== this.generation) return
        this.plan = segmentPlan(maxSegmentSeconds)
        this.segmenter = new SubtitleSegmenter(this.plan)
        this.dual = dual && !asrOnly
        if (this.freshStart) {
          this.freshStart = false
          if (transcriptEnabled === true) {
            this.journal = new SubtitleTranscriptJournal({
              dir: typeof transcriptDir === 'string' ? transcriptDir : '',
              startedAt: Date.now(),
              untranslatedMarker: t('systemAudio.transcriptUntranslatedMarker'),
              onWriteError: (message) => this.reportJournalFailure(message),
            })
            this.journalSequence = 0
          }
        }
        if (asrOnly) {
          this.startOptions = { systemPrompt: '', language, hotwords: [...hotwords], disableAi: true, aiMinDurationSec: 0, requireTranslation: false, disableStreaming: true }
        } else {
          const targetLanguage = this.options!.targetLanguage
          if (!presets.some((preset) => preset.id === `${TRANSLATION_PRESET_PREFIX}${targetLanguage}`)) throw new Error(t('systemAudio.notReady'))
          this.startOptions = { systemPrompt: buildSubtitlePrompt(subtitleLanguageName(targetLanguage)), language, hotwords: [...hotwords], disableAi: false, aiMinDurationSec: 0, requireTranslation: true, disableStreaming: true }
        }
        this.provider = this.dependencies.getProvider()
        this.localModelId = this.provider.mode === 'local' ? await getSetting('localAsr.modelId', '') : ''
        this.liveRequested = liveRecognitionEnabled === true && typeof this.provider.openLive === 'function'
        this.liveSelected = false
        this.snapshot = { ...this.snapshot, liveRecognition: false }
      }
      if (generation !== this.generation) return
      if (this.provider?.mode === 'local') this.dependencies.assertLocalAdmission?.()
      const provider = this.provider
      if (!provider) throw new Error(t('systemAudio.notReady'))
      const acceptAsrWarning = (code: AsrWarningCode | undefined) => {
        if (generation !== this.generation || code !== DEEPGRAM_KEYTERM_LIMIT || this.asrWarning === code) return
        this.asrWarning = code
        this.publish({ warning: this.currentWarning() })
      }
      await provider.connect({
        onReady: (ready) => {
          if (generation !== this.generation) return
          if (!ready.asr || (!asrOnly && provider.mode === 'server' && !ready.llm)) this.fail(t('systemAudio.notReady'))
        },
        onASR: (result) => {
          if (generation !== this.generation || !this.activeJob) return
          acceptAsrWarning(result.asrWarning)
          if (asrOnly) {
            setPipelineActivity({ phase: 'listening', stageStartedAt: null })
            const caption = result.text.trim()
            if (caption) {
              this.publishedAsrJob = this.activeJob
              this.publishCaption(caption, generation)
            }
          } else {
            setPipelineActivity({ phase: 'translation', stageStartedAt: Date.now() })
            const original = result.text.trim()
            if (this.dual && original) this.publishSource(original, generation)
          }
        },
        onFinal: (result) => {
          if (generation !== this.generation || !this.activeJob) return
          acceptAsrWarning(result.asrWarning)
          const jobId = this.activeJob
          setPipelineActivity({ phase: 'listening', stageStartedAt: null })
          if (!result.asrText.trim()) {
            failRun(this.activeRunId, 'empty')
            return
          }
          // One speech-order sequence per recognized fragment: a translation that settles, drops, or is
          // cancelled later than a following one still reaches the journal in speech order.
          const transcriptSequence = ++this.journalSequence
          if (asrOnly) {
            this.consecutiveFailures = 0
            const caption = result.asrText.trim()
            const runId = isPipelineDebugEnabled() ? this.activeRunId : null
            const finishDetails = this.finishDetails(result, caption)
            this.journal?.record({
              sequence: transcriptSequence,
              startedAt: this.activeSpan?.startedAt ?? Date.now(),
              original: caption,
              translation: null,
              untranslated: false,
            })
            if (this.publishedAsrJob !== jobId) {
              this.publishedAsrJob = jobId
              this.publishCaption(caption, generation, runId, finishDetails)
            } else if (this.activeRunId !== null) {
              finishRun(this.activeRunId, finishDetails)
            }
            return
          }
          if (this.activeSpan) this.recent.push(result.asrText.trim(), this.activeSpan)
          // Client-AI modes detach the translation from this run, so the next segment's ASR can start
          // while this text is still being translated.
          if (this.activeSplit) {
            this.enqueueTranslation(result, transcriptSequence)
            this.pumpTranslation()
            return
          }
          this.publishTranslationOutcome(result, this.activeRunId, generation, undefined, {
            sequence: transcriptSequence,
            span: this.activeSpan ?? undefined,
          })
        },
        onDone: () => {
          if (generation !== this.generation || !this.activeJob) return
          this.finishJob(generation)
        },
        onError: (message) => {
          if (generation !== this.generation) return
          const reason = describeProviderError(message).message
          // An error outside any job (connection, readiness) cannot be skipped over.
          if (!this.activeJob) { this.fail(reason); return }
          failRun(this.activeRunId, 'failed', reason)
          this.skipFragment(generation, reason, reason)
        },
        onWarning: acceptAsrWarning,
      })
      if (generation !== this.generation) return
      if (!provider.isReady()) throw new Error(t('systemAudio.notReady'))
      if (this.liveRequested && provider.openLive) {
        const live = await provider.openLive({ ...this.startOptions!, runId: ++sequence }, {
          onResult: (result) => this.receiveLiveResult(generation, result),
          onError: (error) => {
            if (generation !== this.generation || (this.liveSessionId !== null && error.sessionId !== this.liveSessionId)) return
            this.fail(error.message || t('systemAudio.notReady'))
          },
          onWarning: (warning) => {
            if (generation !== this.generation || (this.liveSessionId !== null && warning.sessionId !== this.liveSessionId)) return
            acceptAsrWarning(warning.code)
          },
        })
        if (generation !== this.generation) {
          if (live) await live.close()
          return
        }
        if (!live) {
          if (reuseSnapshot) throw new Error(t('systemAudio.notReady'))
          this.liveRequested = false
          this.liveSelected = false
          this.liveAccumulator = null
          this.snapshot = { ...this.snapshot, liveRecognition: false, liveOriginal: '' }
        } else {
          this.liveSession = live
          this.liveSessionId = live.sessionId
          this.liveSelected = true
          this.liveAccumulator = new LiveSpeechAccumulator({
            language: this.startOptions?.language ?? '',
            targetMs: this.plan.hardFrames * FRAME_MS,
          })
          this.snapshot = { ...this.snapshot, liveRecognition: true, liveOriginal: '' }
          this.listeners.forEach((listener) => listener())
        }
      }
      if (generation !== this.generation) return
      const showId = await this.dependencies.overlay.present(this.overlayPayload())
      if (generation !== this.generation) return
      if (!showId) throw new Error(t('systemAudio.captureFailed'))
      const captureId = ++sequence
      this.captureId = captureId
      this.captureStartIssued = false
      for (const [event, handler] of [
        ['system-audio-frame', (payload: unknown) => this.receiveFrame(payload as SystemAudioFrame, generation, captureId)],
        ['system-audio-live-idle', (payload: unknown) => this.receiveLiveIdle(payload as SystemAudioLiveIdle, generation, captureId)],
        ['system-audio-capture-timing-error', (payload: unknown) => {
          const error = payload as SystemAudioCaptureTimingError
          if (generation === this.generation && this.liveSelected && error.sessionId === captureId) {
            this.fail(t('systemAudio.captureTimingUnavailable'), error.message)
          }
        }],
        ['system-audio-error', (payload: unknown) => {
          const error = payload as { sessionId: number; message: string }
          if (error.sessionId === captureId) this.fail(t('systemAudio.captureFailed'), error.message)
        }],
      ] as const) {
        const unlisten = await bridge.listen<unknown>(event, (data) => {
          if (generation === this.generation) handler(data.payload)
        })
        if (generation !== this.generation) { unlisten(); return }
        this.unlisteners.push(unlisten)
      }
      if (provider.mode === 'local') this.dependencies.assertLocalAdmission?.()
      this.captureStartIssued = true
      let settleCaptureStart!: () => void
      const captureStartCompletion = new Promise<void>((resolve) => { settleCaptureStart = resolve })
      this.captureStartCompletion = captureStartCompletion
      try {
        await bridge.invoke<void>('start_system_audio_capture', { sessionId: captureId, deviceId: this.options!.deviceId || null })
      } finally {
        settleCaptureStart()
        if (this.captureStartCompletion === captureStartCompletion) this.captureStartCompletion = null
      }
        if (generation !== this.generation) {
          await this.stopNativeCapture()
          return
        }
      this.publish({ state: 'listening' })
      setPipelineActivity({ phase: 'listening', segmentMs: 0, stageStartedAt: null })
    } catch (error) {
      if (generation === this.generation) {
        this.fail(this.liveRequested
          ? t('systemAudio.notReady')
          : !this.leased ? t('systemAudio.busy') : this.captureId ? t('systemAudio.captureFailed') : t('systemAudio.notReady'), String(error))
      }
    }
  }

  private receiveFrame(frame: SystemAudioFrame, generation = this.generation, captureId = this.captureId) {
    if (generation !== this.generation || captureId !== this.captureId || frame.sessionId !== captureId
      || !['starting', 'listening'].includes(this.snapshot.state)) return
    let audio: Uint8Array
    try {
      audio = Uint8Array.from(atob(frame.audioB64), (char) => char.charCodeAt(0))
      if (audio.byteLength !== FRAME_BYTES || !Number.isFinite(frame.speechProbability)) throw new Error('Invalid system-audio frame')
    } catch (error) { this.fail(t('systemAudio.captureFailed'), String(error)); return }

    if (frame.discontinuity) {
      countDiscontinuity()
      if (this.liveSelected) {
        this.recoverLiveAfterDiscontinuity()
        return
      }
      this.resetSegment()
      this.publish({ ...NO_CAPTION, warning: t('systemAudio.discontinuity') })
      addRuntimeEvent('warn', 'system-audio', 'Audio gap; unfinished speech discarded, listening continues')
    }

    const now = Date.now()
    if (this.liveSelected) {
      const accumulator = this.liveAccumulator
      if (!accumulator) {
        this.fail(t('systemAudio.notReady'), 'Live recognition state is unavailable')
        return
      }
      const inspected = accumulator.inspectFrame(frame)
      if (inspected.kind === 'error') {
        this.failLiveRecognition(inspected.error)
        return
      }
      if (inspected.kind === 'duplicate') return
      if (inspected.closeGap) this.closeLiveGap()
      accumulator.recordFrame(inspected)
    } else if (this.lastFrameAt) {
      const gapMs = now - this.lastFrameAt
      if (gapMs >= FRAME_RECEIVE_GAP_MS) this.closeGap(gapMs)
      else if (this.segmenter.isSpeechOpen()) noteSpeechFrameGap(gapMs)
    }
    if (this.snapshot.state === 'error') {
      countFrame(audio.byteLength)
      return
    }
    const speechFrame: SubtitleFrame = { audio, probability: frame.speechProbability }
    if (this.liveSelected) {
      countFrame(audio.byteLength, { phase: 'listening', segmentMs: this.liveAccumulator?.audioMs ?? 0 })
      this.sendLiveFrame(audio, generation)
      return
    }
    this.lastFrameAt = now
    if (this.gapTimer) clearTimeout(this.gapTimer)
    // Measure from the last frame, so a timer that fires late (a frozen event loop) still reports the real stall.
    this.gapTimer = setTimeout(() => {
      if (generation !== this.generation) return
      this.closeGap(Date.now() - this.lastFrameAt)
    }, FRAME_RECEIVE_GAP_MS)
    // Capture-driven phases must stay out of the way while a queued ASR or translation job is in flight,
    // otherwise the next captured frame immediately hides the stage that stageElapsedMs is timing.
    const processing = this.activeJob !== 0 || this.translating !== null
    const result = this.segmenter.push(speechFrame)
    countFrame(audio.byteLength, processing ? undefined : {
      phase: result.segmentMs ? 'speech' : 'listening',
      segmentMs: result.segmentMs,
    })
    if (result.sealed) this.enqueueSegment(result.sealed)
  }

  private sendLiveFrame(audio: Uint8Array, generation: number) {
    const live = this.liveSession
    const accumulator = this.liveAccumulator
    if (!live || !accumulator || !this.liveSelected || generation !== this.generation) return
    try {
      live.sendAudio(audio.buffer as ArrayBuffer)
    } catch (error) {
      this.fail(String(error))
      return
    }
    if (generation !== this.generation || live !== this.liveSession) return
    const sendResult = accumulator.markFrameSent()
    // A target crossing during silence must not flush the stream: Deepgram would finalize a
    // stray word into a phrase of its own. Flush only while speech is actually pending.
    // The flush answer confirms the whole window and commits it as one caption; committing a
    // confirmed prefix here would make that answer publish the tail as a second, replacing caption.
    if (!sendResult.targetCrossed || !sendResult.pendingText) return
    this.requestLiveFinalize(generation, 'cap')
  }

  private receiveLiveIdle(idle: SystemAudioLiveIdle, generation: number, captureId: number) {
    if (generation !== this.generation || !this.liveSelected || !['starting', 'listening'].includes(this.snapshot.state)
      || idle.sessionId !== captureId || idle.sessionId !== this.captureId) return
    const accumulator = this.liveAccumulator
    if (!accumulator) {
      this.fail(t('systemAudio.notReady'), 'Live recognition state is unavailable')
      return
    }
    const outcome = accumulator.acceptIdle(idle)
    if (outcome.kind === 'error') {
      this.failLiveRecognition(outcome.error)
      return
    }
    if (outcome.kind === 'closeGap') this.closeLiveGap()
  }

  private receiveLiveResult(generation: number, result: LiveAsrResult) {
    if (generation !== this.generation || !this.liveSelected || this.liveSessionId !== result.sessionId) return
    const accumulator = this.liveAccumulator
    if (!accumulator) {
      this.fail(t('systemAudio.notReady'), 'Live recognition state is unavailable')
      return
    }
    const outcome = accumulator.acceptResult(result, Date.now())
    if (outcome.kind === 'error') {
      this.failLiveRecognition(outcome.error)
      return
    }
    if (outcome.kind === 'ignored') return
    if (outcome.kind === 'updated') {
      this.publish({ liveOriginal: this.retainedLiveOriginal(outcome.liveOriginal) })
      return
    }
    if (outcome.matchedFinalizeRequest) accumulator.consumeFinalizeRequest(outcome.matchedFinalizeRequest)
    this.commitLivePhrase(outcome.boundaryAudioMs, outcome.closeReason, outcome.targetStartMs)
  }

  private failLiveRecognition(error: LiveRecognitionError) {
    switch (error.kind) {
      case 'overflow':
        this.fail(t('systemAudio.livePhraseOverflow'))
        return
      case 'timingUnavailable':
        this.fail(t('systemAudio.liveTimingUnavailable'))
        return
      case 'frameTiming':
      case 'anchor':
      case 'frameSequence':
      case 'idle':
      case 'resultRange':
        this.fail(t('systemAudio.notReady'), error.detail)
        return
      default: {
        const unreachable: never = error.kind
        throw new Error(`Unhandled live recognition error: ${unreachable}`)
      }
    }
  }

  private commitLivePhrase(boundaryAudioMs: number, closeReason: SegmentCloseReason, targetStartMs = this.liveAccumulator?.audioMs ?? 0) {
    const accumulator = this.liveAccumulator
    if (!accumulator) return
    const prepared = accumulator.prepareCommit(boundaryAudioMs, targetStartMs)
    if (prepared.kind === 'none') return
    if (prepared.kind === 'error') {
      this.failLiveRecognition(prepared.error)
      return
    }
    const generation = this.generation
    let job: TranslationJob | null = null
    let recognitionOnlyResult: {
      caption: string
      phraseId: number
      runId: number | null
      finishDetails: PipelineFinishDetails
    } | null = null

    if (prepared.text && prepared.startedAt !== null && prepared.endedAt !== null) {
      const text = prepared.text
      const sourceSpan = { startedAt: prepared.startedAt, endedAt: prepared.endedAt }
      const context = this.translationContext(sourceSpan)
      const phraseId = ++sequence
      const transcriptSequence = ++this.journalSequence
      const asrMs = Math.max(0, (prepared.confirmedAt ?? Date.now()) - sourceSpan.endedAt)
      const speechMs = Math.max(0, sourceSpan.endedAt - sourceSpan.startedAt)
      const asrEngine = prepared.asrEngine || 'deepgram'
      const asrModel = prepared.asrModel
      const runId = beginRun({
        mode: this.provider?.mode ?? 'unknown',
        speechMs,
        closeReason,
        recognitionKind: 'live',
        asrOnly: this.options?.asrOnly ?? false,
      })
      this.recent.push(text, sourceSpan)
      if (this.options?.asrOnly) {
        const caption = text
        const finishDetails: PipelineFinishDetails = {
          asrMs,
          llmMs: 0,
          asrEngine,
          asrModel,
          asrChars: text.length,
          captionChars: caption.length,
        }
        this.consecutiveFailures = 0
        recognitionOnlyResult = { caption, phraseId, runId, finishDetails }
        this.journal?.record({
          sequence: transcriptSequence,
          startedAt: sourceSpan.startedAt,
          original: text,
          translation: null,
          untranslated: false,
        })
      } else {
        job = {
          runId,
          asrText: text,
          asrMs,
          durationSec: speechMs / 1000,
          speechMs,
          context,
          asrEngine,
          asrModel,
          phraseId,
          sourceSpan,
          journalSequence: transcriptSequence,
        }
      }
    }

    const liveOriginal = accumulator.completeCommit(prepared).liveOriginal
    this.clearLiveSettleFallback()
    if (recognitionOnlyResult) {
      this.publish({
        caption: recognitionOnlyResult.caption,
        captionNotice: '',
        source: '',
        warning: this.currentWarning(),
        liveOriginal,
      }, recognitionOnlyResult.runId, recognitionOnlyResult.finishDetails)
      this.holdCaption(generation, recognitionOnlyResult.phraseId)
    } else if (this.dual) {
      this.publish({ liveOriginal })
    } else {
      this.publish({ liveOriginal: this.retainedLiveOriginal(liveOriginal || prepared.text) })
    }
    if (job) {
      this.enqueueTranslation(job)
      this.pumpTranslation()
    }
  }

  private requestLiveFinalize(generation: number, reason: SegmentCloseReason) {
    const live = this.liveSession
    const accumulator = this.liveAccumulator
    if (!live || !accumulator) return
    const request = accumulator.registerFinalize(reason)
    if (!request) return
    this.armLiveSettleFallback(generation, request)
    void live.finalize().catch((error: unknown) => {
      if (generation === this.generation && live === this.liveSession) this.fail(String(error))
    })
  }

  // The provider's flush answer carries the whole phrase, and the regular result path publishes it.
  // This fallback settles the confirmed text anyway when that answer is late or lost, so a stalled
  // stream cannot freeze captions; it never promotes interim text.
  private armLiveSettleFallback(generation: number, request: LiveFinalizeRequest) {
    this.clearLiveSettleFallback()
    this.liveSettleTimer = setTimeout(() => {
      this.liveSettleTimer = null
      if (generation !== this.generation) return
      const accumulator = this.liveAccumulator
      if (!accumulator || !this.liveSelected) return
      const boundary = accumulator.confirmedBoundaryMs
      if (boundary === null) return
      // A cap flush settles on its window grid, exactly like its answer; a pause anchors at the
      // current frontier, as its answer does.
      const targetStartMs = request.closeReason === 'cap' ? request.targetStartMs : accumulator.audioMs
      addRuntimeEvent('warn', 'system-audio', 'Live flush answer is late; settling confirmed speech', { reason: request.closeReason })
      this.commitLivePhrase(boundary, request.closeReason, targetStartMs)
    }, LIVE_SETTLE_FALLBACK_MS)
  }

  private clearLiveSettleFallback() {
    if (this.liveSettleTimer) clearTimeout(this.liveSettleTimer)
    this.liveSettleTimer = null
  }

  private closeLiveGap() {
    const accumulator = this.liveAccumulator
    if (!this.liveSelected || !accumulator) return
    // Like the target flush, a pause settles through the provider's answer: committing the
    // confirmed prefix here would leave that answer to publish the tail as a second caption.
    if (accumulator.shouldFinalizeOnGap()) this.requestLiveFinalize(this.generation, 'gap')
  }

  private recoverLiveAfterDiscontinuity() {
    if (this.liveRecovery) return
    const generation = ++this.generation
    this.liveDiscontinuityWarning = t('systemAudio.discontinuity')
    this.clearWork(true)
    this.publish({ state: 'starting', ...NO_CAPTION, liveRecognition: true, error: '', warning: this.currentWarning() })
    addRuntimeEvent('warn', 'system-audio', 'Audio gap; unfinished live speech discarded before restarting the capture epoch')

    const operation = (async () => {
      const provider = this.provider
      await this.cleanupCapture(true)
      if (generation !== this.generation) return
      if (provider && this.provider === provider) {
        provider.disconnect()
      }
      await this.begin(true, true)
    })()
    this.liveRecovery = operation
    void operation.catch((error: unknown) => {
      if (generation !== this.generation) return
      const detail = String(error)
      this.publish({ state: 'error', error: `${t('systemAudio.cleanupFailed')}: ${detail}`, warning: this.currentWarning() })
    }).finally(() => {
      if (this.liveRecovery === operation) this.liveRecovery = null
    })
  }

  // No frame arrived for `gapMs`: either playback stopped or frame delivery stalled. The two look the same here, but
  // the last frame tells them apart for diagnostics: a voiced one means speech was cut off mid-way.
  private closeGap(gapMs: number) {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
    if (this.liveSelected) {
      this.closeLiveGap()
      this.lastFrameAt = 0
      return
    }
    if (this.segmenter.isSpeechOpen()) noteSpeechFrameGap(gapMs)
    const sealed = this.segmenter.closeGap()
    if (sealed) this.enqueueSegment(sealed)
    this.lastFrameAt = 0
  }

  private enqueueSegment(segment: SealedSubtitleSegment) {
    this.dropOldestToFit(segment.audio.byteLength)
    const runId = beginRun({ mode: this.provider?.mode ?? 'unknown', speechMs: segment.speechMs, closeReason: segment.closeReason, asrOnly: this.options?.asrOnly ?? false })
    const endedAt = Date.now()
    this.queue.push({ audio: segment.audio, runId, startedAt: endedAt - segment.speechMs, endedAt })
    this.queuedBytes += segment.audio.byteLength
    this.publishQueueDepth()
    this.processNext()
  }

  // Captions older than the speech now playing are worthless, so when processing falls behind the oldest waiting
  // speech is dropped to bound the backlog; the session keeps listening.
  private dropOldestToFit(incomingBytes: number) {
    let dropped = false
    while (this.queue.length && this.queuedBytes + incomingBytes > MAX_PENDING_BYTES) {
      const oldest = this.queue.shift()!
      this.queuedBytes -= oldest.audio.byteLength
      failRun(oldest.runId, 'failed', 'dropped: processing is behind playback')
      dropped = true
    }
    if (dropped) this.publish({ warning: this.liveSelected
      ? this.currentWarning(t('systemAudio.behind'))
      : t('systemAudio.behind') })
  }

  // Ends the active job and, once the provider is done with its callback, starts the next queued one.
  private finishJob(generation: number) {
    setPipelineActivity({ phase: 'listening', stageStartedAt: null })
    this.activeJob = 0
    this.activeSpan = null
    this.activeContext = undefined
    this.activeSplit = false
    this.publishedAsrJob = 0
    this.activeRunId = null
    if (this.processingTimer) clearTimeout(this.processingTimer)
    this.processingTimer = null
    // Providers finalize their run after onDone returns. Never start a new run inside that callback.
    queueMicrotask(() => {
      if (generation !== this.generation) return
      this.processNext()
      this.pumpTranslation()
    })
  }

  /** Counts a failed fragment and stops the session once too many failed in a row. Returns true when it stopped. */
  private recordFailure(message: string): boolean {
    if (++this.consecutiveFailures < MAX_CONSECUTIVE_FAILURES) return false
    this.fail(message)
    return true
  }

  // Gives up on the active fragment, tells the user, and moves on to the next one. A provider reports a failed job
  // with onError immediately followed by onDone (or without onDone at all); finishJob makes either order safe,
  // because the trailing onDone finds no active job.
  private skipFragment(generation: number, failure: string, reason = failure) {
    if (this.recordFailure(failure)) return
    const fragmentWarning = t('systemAudio.fragmentSkipped', { reason })
    this.publish({ warning: this.liveSelected ? this.currentWarning(fragmentWarning) : fragmentWarning })
    this.finishJob(generation)
  }

  private processNext() {
    if (this.activeJob || !this.provider || !this.startOptions || !['starting', 'listening'].includes(this.snapshot.state)) return
    const job = this.queue.shift()
    if (!job) return
    this.queuedBytes -= job.audio.byteLength
    this.activeRunId = job.runId
    this.activeSpan = { startedAt: job.startedAt, endedAt: job.endedAt }
    this.activeContext = this.translationContext(job)
    // Client-AI modes can translate in a separate lane; a managed server run cannot.
    this.activeSplit = !this.options?.asrOnly && this.usesClientTranslation()
    this.publishedAsrJob = 0
    markQueued(job.runId)
    this.publishQueueDepth()
    const generation = this.generation
    this.activeJob = ++sequence
    this.processingTimer = setTimeout(() => {
      if (generation !== this.generation || !this.activeJob) return
      if (this.activeRunId !== null) {
        failRun(this.activeRunId, 'timeout', t('systemAudio.timeout'))
        this.activeRunId = null
      }
      // Abandon the stuck run: after cancel() the provider drops anything it still returns for it.
      this.provider?.cancel()
      this.skipFragment(generation, t('systemAudio.timeout'), t('systemAudio.timeoutReason'))
    }, PROCESSING_TIMEOUT_MS)
    try {
      const startOptions: StartOptions = {
        ...this.startOptions,
        // A split run must not translate inside the provider: the translation lane owns that stage.
        disableAi: this.activeSplit || Boolean(this.startOptions.disableAi),
        textContext: this.activeContext,
        runId: this.activeJob,
      }
      if (!this.provider.start(startOptions)) throw new Error('ASR did not start')
      setPipelineActivity({ phase: 'asr', stageStartedAt: Date.now() })
      this.provider.sendAudio(job.audio.buffer as ArrayBuffer)
      if (!this.provider.stop()) throw new Error('ASR did not accept the segment')
    } catch (error) { this.fail(t('systemAudio.notReady'), String(error)) }
  }

  // The speech recognized just before this segment, passed to the translation as read-only context.
  private translationContext(job: SegmentSpan): TextContext | undefined {
    if (this.provider?.acceptsTextContext?.() === false) return undefined
    const textBefore = this.recent.contextBefore(job.startedAt)
    return textBefore ? { source: SUBTITLE_CONTEXT_SOURCE, textBefore, selectedText: '', textAfter: '', selectionTruncated: false } : undefined
  }

  // Client API, local and custom-AI server modes run their AI stage on this client, so it can be a lane
  // of its own. A managed server run performs ASR and translation inside one server run.
  private usesClientTranslation(): boolean {
    const provider = this.provider
    if (!provider) return false
    return provider.mode !== 'server' || getRuntimeServerAiSource() === 'custom'
  }

  private publishQueueDepth(): void {
    setQueueDepth(this.queue.length + this.translations.length)
  }

  private enqueueTranslation(result: FinalResult | TranslationJob, transcriptSequence?: number): void {
    const job: TranslationJob = 'runId' in result
      ? result
      : {
          runId: this.activeRunId,
          asrText: result.asrText,
          asrMs: result.asrMs,
          durationSec: result.durationSec,
          speechMs: this.activeSpan ? Math.max(0, this.activeSpan.endedAt - this.activeSpan.startedAt) : 0,
          context: this.activeContext,
          asrEngine: result.asrEngine,
          asrModel: result.asrModel,
          journalSequence: transcriptSequence,
          sourceSpan: this.activeSpan ? { ...this.activeSpan } : undefined,
        }
    this.translations.push(job)
    this.translationBacklogMs += job.speechMs
    // Translations older than the speech now playing are worthless; drop the oldest waiting ones to bound the
    // backlog, mirroring dropOldestToFit, and keep listening.
    let dropped = false
    while (this.translations.length && this.translationBacklogMs > MAX_TRANSLATION_BACKLOG_MS) {
      const oldest = this.translations.shift()!
      this.translationBacklogMs -= oldest.speechMs
      failRun(oldest.runId, 'failed', 'dropped: translation is behind playback')
      this.recordUnfinishedTranscript(oldest)
      dropped = true
    }
    if (dropped) this.publish({ warning: this.liveSelected
      ? this.currentWarning(t('systemAudio.behind'))
      : t('systemAudio.behind') })
    this.publishQueueDepth()
  }

  // One translation at a time, in speech order: captions must follow each other the way they were spoken.
  private pumpTranslation(): void {
    if (this.translating || !this.translations.length || !['starting', 'listening'].includes(this.snapshot.state)) return
    const job = this.translations.shift()!
    this.translationBacklogMs = Math.max(0, this.translationBacklogMs - job.speechMs)
    this.publishQueueDepth()
    markQueued(job.runId)
    this.translating = job
    this.lastPartialAt = 0
    if (job.phraseId !== undefined) {
      if (this.captionTimer) clearTimeout(this.captionTimer)
      this.captionTimer = null
      this.settledCaptionPhraseId = job.phraseId
      if (this.dual) {
        // Dual mode pairs the incoming original with its own pending translation; the previous
        // translation must never sit under the next phrase's original.
        this.publish({ caption: '', captionNotice: '', source: job.asrText, warning: this.currentWarning() })
      }
      // Single-subtitle live keeps the previous translation on screen until the streamed
      // replacement arrives, so the settled card never blinks empty between phrases.
    }
    const generation = this.generation
    // While an ASR run is active, the live stage already reflects the lane that gates the queue.
    if (!this.activeJob) setPipelineActivity({ phase: 'translation', stageStartedAt: Date.now() })
    void this.translateWithClientAi(job, generation)
  }

  private async translateWithClientAi(job: TranslationJob, generation: number): Promise<void> {
    const startOptions: StartOptions = { ...this.startOptions!, runId: job.runId ?? 0, textContext: job.context }
    let polish: Awaited<ReturnType<typeof polishWithClientAi>>
    try {
      polish = await polishWithClientAi({
        asrText: job.asrText,
        durationSec: job.durationSec,
        startOptions,
        logSource: this.provider?.mode ?? 'unknown',
        isCurrent: () => generation === this.generation && this.translating === job,
        onPartial: STREAM_SUBTITLE_TRANSLATIONS
          ? (text) => this.publishPartialTranslation(job, text, generation)
          : undefined,
      })
    } catch (error) {
      // polishWithClientAi can reject before its own request-error handling, for example when the AI settings
      // cannot be read. The lane must not stay occupied: treat it as a failed translation.
      addRuntimeEvent('warn', this.provider?.mode ?? 'unknown', 'Subtitle translation failed before its request', { error: String(error) })
      polish = { llmText: '', llmMs: 0, aiSource: 'custom', aiStatus: 'failed' }
    }
    if (generation !== this.generation || this.translating !== job) return
    this.translating = null
    if (!polish) { this.pumpTranslation(); return }
    const outcome: FinalResult = {
      ...polish,
      asrText: job.asrText,
      asrMs: job.asrMs,
      durationSec: job.durationSec,
      asrEngine: job.asrEngine,
      asrModel: job.asrModel,
    }
    if (!this.publishTranslationOutcome(outcome, job.runId, generation, job.phraseId,
      job.journalSequence === undefined ? undefined : { sequence: job.journalSequence, span: job.sourceSpan })) return
    if (!this.activeJob) setPipelineActivity({ phase: 'listening', stageStartedAt: null })
    this.pumpTranslation()
  }

  private resetSegment() {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
    this.segmenter.reset()
    this.lastFrameAt = 0
  }

  private clearWork(preserveWarnings = false) {
    this.resetSegment()
    for (const timer of [this.processingTimer, this.captionTimer, this.liveSettleTimer]) if (timer) clearTimeout(timer)
    this.processingTimer = this.captionTimer = this.liveSettleTimer = null
    this.settledCaptionPhraseId = null
    if (this.activeRunId !== null) {
      failRun(this.activeRunId, 'cancelled')
      this.activeRunId = null
    }
    this.queue.forEach(({ runId }) => failRun(runId, 'cancelled'))
    this.queue = []
    if (this.translating) {
      failRun(this.translating.runId, 'cancelled')
      this.recordUnfinishedTranscript(this.translating)
      this.translating = null
    }
    this.translations.forEach((job) => {
      failRun(job.runId, 'cancelled')
      this.recordUnfinishedTranscript(job)
    })
    this.translations = []
    this.translationBacklogMs = 0
    this.recent.clear()
    this.activeSpan = null
    this.consecutiveFailures = 0
    this.activeContext = undefined
    this.activeSplit = false
    if (!preserveWarnings) this.asrWarning = null
    this.queuedBytes = this.activeJob = 0
    this.publishedAsrJob = 0
    this.liveAccumulator?.reset()
    this.lastLiveOriginal = ''
    setQueueDepth(0)
    setPipelineActivity({ phase: 'idle', segmentMs: 0, stageStartedAt: null })
    this.unlisteners.splice(0).forEach((unlisten) => unlisten())
    if (!this.liveRequested && !this.liveSession) {
      this.liveSelected = false
      this.provider?.disconnect()
    }
  }

  private async closeLiveProvider() {
    const provider = this.provider
    const live = this.liveSession
    // The provider owns pending opens as well as the current handle; close it only once.
    if (provider?.closeLive) await provider.closeLive()
    else if (live) await live.close()
    if (this.provider !== provider || this.liveSession !== live) return
    this.liveSession = null
    this.liveSessionId = null
    this.liveSelected = false
    this.liveAccumulator = null
    if (this.snapshot.liveRecognition) this.publish({ liveRecognition: false, liveOriginal: '' })
  }

  private cleanupCapture(preserveProvider = false): Promise<void> {
    if (this.liveCleanup) return this.liveCleanup
    const operation = this.stopCaptureAndProvider(preserveProvider)
    this.liveCleanup = operation
    const clear = () => {
      if (this.liveCleanup === operation) this.liveCleanup = null
    }
    void operation.then(clear, clear)
    return operation
  }

  private async stopCaptureAndProvider(preserveProvider: boolean) {
    const closeLive = this.liveRequested || this.liveSession !== null
    const provider = this.provider
    const captureStop = this.stopNativeCapture()
    const liveClose = closeLive ? this.closeLiveProvider() : Promise.resolve()
    const [captureResult, liveResult] = await Promise.allSettled([captureStop, liveClose])
    if (!preserveProvider && this.provider === provider && this.liveSession === null
      && closeLive && captureResult.status === 'fulfilled' && liveResult.status === 'fulfilled' && provider) {
      provider.disconnect()
      this.provider = null
    }
    if (this.liveSession === null && !preserveProvider
      && captureResult.status === 'fulfilled' && liveResult.status === 'fulfilled') {
      this.liveRequested = false
    }
    const errors = [captureResult, liveResult]
      .flatMap((result) => result.status === 'rejected' ? [String(result.reason)] : [])
    if (errors.length) throw new Error(errors.join('; '))
  }

  private stopNativeCapture() {
    const captureId = this.captureId
    if (!captureId) return this.captureStop
    if (!this.captureStartIssued) {
      if (this.captureId === captureId) this.captureId = 0
      return this.captureStop
    }
    if (this.captureStopId === captureId) return this.captureStop
    const captureStartCompletion = this.captureStartCompletion
    const stop = async () => {
      if (captureStartCompletion) await captureStartCompletion
      await bridge.invoke<void>('stop_system_audio_capture', { sessionId: captureId })
      if (this.captureId === captureId) {
        this.captureId = 0
        this.captureStartIssued = false
      }
    }
    this.captureStopId = captureId
    const operation = this.captureStop.then(stop, stop)
    this.captureStop = operation.finally(() => {
      if (this.captureStopId === captureId) this.captureStopId = 0
    })
    return this.captureStop
  }

  private fail(message: string, detail?: string) {
    if (this.snapshot.state === 'error' || this.snapshot.state === 'stopping') return
    if (this.activeRunId !== null) {
      failRun(this.activeRunId, 'failed', message)
      this.activeRunId = null
    }
    const generation = ++this.generation
    const needsLiveClose = this.liveRequested || this.liveSession !== null
    this.clearWork(needsLiveClose)
    this.publish({ state: 'error', ...NO_CAPTION, error: message, warning: this.currentWarning() })
    addRuntimeEvent('warn', 'system-audio', 'Subtitle session interrupted', { message, detail })
    void this.waitForCleanup(this.cleanupCapture(), generation).then(() => {
      if (generation === this.generation && this.snapshot.error !== message) this.publish({ error: message })
    }).catch((error: unknown) => {
      addRuntimeEvent('error', 'system-audio', 'Capture or live ASR cleanup failed', { error: String(error) })
      if (generation !== this.generation) return
      this.publish({ error: `${message} ${t('systemAudio.cleanupFailed')}: ${String(error)}`, warning: this.currentWarning() })
    })
  }

  async pause(): Promise<void> {
    if (this.snapshot.state !== 'listening') return
    const generation = ++this.generation
    const needsLiveClose = this.liveRequested || this.liveSession !== null
    this.clearWork(needsLiveClose)
    this.publish({ state: 'paused', ...NO_CAPTION, warning: this.currentWarning() })
    try {
      await this.waitForCleanup(this.cleanupCapture(), generation)
      if (generation === this.generation && this.snapshot.error) this.publish({ error: '' })
    } catch (error) {
      if (generation !== this.generation) return
      this.publish({ state: 'error', error: `${t('systemAudio.cleanupFailed')}: ${String(error)}`, warning: this.currentWarning() })
    }
  }

  async resume(): Promise<void> {
    if (!['paused', 'error'].includes(this.snapshot.state) || !this.options || this.stopping) return
    const generation = ++this.generation
    this.publish({ state: 'starting', error: '', warning: this.currentWarning() })
    try {
      await this.waitForCleanup((async () => {
        await this.cleanupCapture()
        await this.starting
        await this.liveRecovery
      })(), generation)
    } catch (error) {
      if (generation !== this.generation) return
      this.publish({ state: 'error', error: `${t('systemAudio.cleanupFailed')}: ${String(error)}`, warning: this.currentWarning() })
      return
    }
    if (generation !== this.generation || this.stopping) return
    this.clearWork()
    await this.begin()
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.snapshot.state === 'idle') return
    const generation = ++this.generation
    this.publish({ state: 'stopping', ...NO_CAPTION, error: '', warning: this.currentWarning() })
    this.clearWork(this.liveRequested || this.liveSession !== null)
    const operation = this.release()
    this.stopping = operation
    try { await this.waitForCleanup(operation, generation) } finally { if (this.stopping === operation) this.stopping = null }
  }

  private async waitForCleanup(operation: Promise<void>, generation: number): Promise<void> {
    const timer = setTimeout(() => {
      if (generation !== this.generation) return
      // Diagnose a delay without abandoning cleanup or enqueueing updates during overlay hiding.
      this.snapshot = { ...this.snapshot, error: t('systemAudio.cleanupUnconfirmed') }
      this.listeners.forEach((listener) => listener())
    }, LIVE_STOP_WATCHDOG_MS)
    try { await operation } finally { clearTimeout(timer) }
  }

  private async release() {
    try {
      await this.cleanupCapture()
      await this.starting
      await this.liveRecovery
      this.liveRequested = false
      this.clearWork()
      const journal = this.journal
      this.journal = null
      if (journal) {
        // The journal keeps finishing in the background; the deadline only bounds how long stop waits.
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, JOURNAL_FLUSH_TIMEOUT_MS)
          void journal.finish().then(() => { clearTimeout(timer); resolve() })
        })
      }
      await this.awaitOverlayUpdates()
      if (this.leased) {
        await this.dependencies.overlay.hide()
        await this.dependencies.release()
        this.leased = false
      }
      this.provider = null
      this.liveSelected = false
      this.liveSession = null
      this.liveSessionId = null
      this.liveAccumulator = null
      this.liveDiscontinuityWarning = ''
      this.publish({ state: 'idle', ...NO_CAPTION, liveRecognition: false, error: '', warning: '' })
    } catch (error) {
      this.publish({ state: 'error', error: `${t('systemAudio.cleanupFailed')}: ${String(error)}`, warning: this.currentWarning() })
      addRuntimeEvent('error', 'system-audio', 'Subtitle session release failed', { error: String(error) })
    }
  }
}

export const systemAudioSession = new SystemAudioSession({
  acquire: acquireSystemAudio,
  release: releaseSystemAudio,
  getProvider,
  assertLocalAdmission: assertLocalSystemAudioAdmission,
  overlay: {
    present: presentSubtitleOverlay,
    update: updateSubtitleOverlay,
    hide: hideSubtitleOverlay,
  },
})

if (import.meta.hot) import.meta.hot.dispose(() => { void systemAudioSession.stop() })

import * as bridge from './bridge'
import { t } from '@/i18n'
import { getPromptPresets, getSetting, TRANSLATION_PRESET_PREFIX } from './store'
import { normalizeSpeechInputLanguage, type SpeechInputLanguage } from './speechInputLanguage'
import { chooseForcedSplit, DEFAULT_SEGMENT_SECONDS, FRAME_MS, normalizeSegmentSeconds, segmentPlan, type SegmentPlan } from './subtitleSegmentation'
import { buildSubtitlePrompt, RecentSpeech, SUBTITLE_CONTEXT_SOURCE, subtitleLanguageName } from './subtitleTranslation'
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

export interface SystemAudioFrame {
  sessionId: number
  audioB64: string
  speechProbability: number
  discontinuity: boolean
  frameSequence: number
  captureStartUnixUs: number | null
  captureEndUnixUs: number | null
  captureAnchors: Array<{ audioOffsetSamples: number; captureUnixUs: number }>
}

interface SystemAudioLiveIdle {
  sessionId: number
  frameSequence: number
  lastFrameCaptureEndUnixUs: number | null
  lastAudioCaptureEndUnixUs: number | null
  confirmedThroughUnixUs: number
}

interface SystemAudioCaptureTimingError {
  sessionId: number
  message: string
}

interface SessionDependencies {
  acquire: () => Promise<void>
  release: () => Promise<void>
  getProvider: () => TranscriptionProvider
  overlay: {
    present: (payload: SubtitleOverlayPayload) => Promise<number>
    update: (payload: SubtitleOverlayPayload) => Promise<void>
    hide: () => Promise<void>
  }
}

interface SpeechFrame {
  audio: Uint8Array
  probability: number
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
}

interface OverlayDelivery {
  generation: number
  payload: SubtitleOverlayPayload
  runId: number | null
  finishDetails?: PipelineFinishDetails
}

interface LiveTimeAnchor {
  audioMs: number
  capturedAt: number
}

interface LiveFinalizeRequest {
  afterFrontierMs: number
  frontierMs: number
  closeReason: SegmentCloseReason
  targetStartMs: number
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

// Must match FRAME_SAMPLES = 512 i16 little-endian samples emitted by client/src-tauri/src/commands/system_audio.rs; receiveFrame hard-fails if the byte length differs.
const FRAME_BYTES = 512 * 2
const MAX_LIVE_PHRASE_BYTES = 16 * 1024
const MAX_LIVE_TIME_ANCHORS = 64
const MAX_LIVE_FINALIZE_REQUESTS = 32
const LIVE_IDLE_CONFIRMATION_US = 512_000
const LIVE_CAPTURE_TIME_TOLERANCE_US = 4
const LIVE_STOP_WATCHDOG_MS = 5_000
const PRE_ROLL_FRAMES = 8
const MIN_VOICED_FRAMES = 8
const END_SILENCE_FRAMES = 15
// A pause this long (160 ms) is a phrase boundary, not a gap between words or a stop consonant.
// Once a segment has reached its soft length (see segmentPlan) the first such pause closes it early,
// so continuous speech is cut between phrases instead of waiting for the hard cap.
const PAUSE_SPLIT_FRAMES = 5
// Silero speech probability at or above which a frame counts as voiced.
const SPEECH_THRESHOLD = 0.3
const isVoiced = (frame: SpeechFrame) => frame.probability >= SPEECH_THRESHOLD
const MAX_PENDING_BYTES = 16_000 * 2 * 12
// Close the current speech segment after this receive inactivity interval.
const FRAME_RECEIVE_GAP_MS = 512
const PROCESSING_TIMEOUT_MS = 30_000
// One bad fragment (a slow or failing AI, a recognition error) is skipped or shown untranslated. The session
// stops only when this many fragments fail back to back, which means the service itself is down or misconfigured.
const MAX_CONSECUTIVE_FAILURES = 3
const CAPTION_HOLD_MS = 8_000
// Streamed translation text is repainted at most this often; the settled caption is always published.
const PARTIAL_UPDATE_INTERVAL_MS = 100
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
  private frames: SpeechFrame[] = []
  private preRoll: SpeechFrame[] = []
  private plan: SegmentPlan = segmentPlan(DEFAULT_SEGMENT_SECONDS)
  // Fixed per start: the overlay window is sized once, so the layout must not change under a running session.
  private dual = false
  private voicedFrames = 0
  private silenceFrames = 0
  private continuation = false
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
  private settledCaptionPhraseId: number | null = null
  private liveRequested = false
  private liveSelected = false
  private liveSession: LiveAsrSession | null = null
  private liveSessionId: string | null = null
  private liveLastResultId = 0
  private liveAudioMs = 0
  private liveTimeAnchors: LiveTimeAnchor[] = []
  private liveLastCaptureFrameSequence = 0
  private liveLastCaptureFrameEndUnixUs: number | null = null
  private liveLastIdleFrameSequence = -1
  private liveLastIdleAudioEndUnixUs = -1
  private liveStableWatermark = 0
  private liveCommittedWatermark = 0
  private liveConfirmedText = ''
  private liveConfirmedStartMs: number | null = null
  private liveConfirmedEndMs = 0
  private liveConfirmedAt: number | null = null
  private liveInterimText = ''
  private liveInterimStartMs: number | null = null
  private liveInterimEndMs = 0
  private livePhraseStartMs: number | null = null
  private livePhraseEngine = ''
  private livePhraseModel = ''
  private liveTargetStartMs = 0
  private liveFinalizedFrontier = -1
  private liveFinalizeRequests: LiveFinalizeRequest[] = []
  private liveLastFinalizeRequest: LiveFinalizeRequest | null = null
  private liveFinalizeRetiredThrough = -1
  private liveDiscontinuityWarning = ''

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
  private publishTranslationOutcome(result: FinalResult, runId: number | null, generation: number, phraseId?: number): boolean {
    const original = result.asrText.trim()
    const comparableTranslation = result.llmText.replace(/\s+/g, ' ').trim()
    const comparableSource = result.asrText.replace(/\s+/g, ' ').trim()
    if (result.aiStatus !== 'applied' || !comparableTranslation) {
      // The AI produced no translation. Show what was heard, marked as untranslated, and keep listening.
      failRun(runId, 'rejected', result.aiStatus !== 'applied' ? result.aiStatus : 'empty translation')
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
        const [presets, language, hotwords, maxSegmentSeconds, dual, liveRecognitionEnabled] = await Promise.all([
          asrOnly ? Promise.resolve([]) : getPromptPresets(),
          getSystemAudioSourceLanguage(),
          loadActiveHotwords(),
          getSystemAudioMaxSegmentSeconds(),
          getSystemAudioDualSubtitles(),
          getSetting('systemAudio.liveRecognitionEnabled', false),
        ])
        if (generation !== this.generation) return
        this.plan = segmentPlan(maxSegmentSeconds)
        this.dual = dual && !asrOnly
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
          if (asrOnly) {
            this.consecutiveFailures = 0
            const caption = result.asrText.trim()
            const runId = isPipelineDebugEnabled() ? this.activeRunId : null
            const finishDetails = this.finishDetails(result, caption)
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
            this.enqueueTranslation(result)
            this.pumpTranslation()
            return
          }
          this.publishTranslationOutcome(result, this.activeRunId, generation)
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
          this.snapshot = { ...this.snapshot, liveRecognition: false, liveOriginal: '' }
        } else {
          this.liveSession = live
          this.liveSessionId = live.sessionId
          this.liveSelected = true
          this.resetLiveRecognition()
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
      if (!Number.isSafeInteger(frame.frameSequence) || frame.frameSequence < 1
        || !Number.isSafeInteger(frame.captureStartUnixUs) || !Number.isSafeInteger(frame.captureEndUnixUs)
        || frame.captureStartUnixUs === null || frame.captureEndUnixUs === null
        || frame.captureEndUnixUs - frame.captureStartUnixUs < FRAME_MS * 1_000 - LIVE_CAPTURE_TIME_TOLERANCE_US
        || !Array.isArray(frame.captureAnchors) || frame.captureAnchors.length > MAX_LIVE_TIME_ANCHORS) {
        this.fail(t('systemAudio.notReady'), 'Missing or malformed native source capture timing')
        return
      }
      // Native owns the timing policy and already absorbs the audio engine's sub-millisecond
      // clock slew, so the boundary verifies only that the payload is structurally sound:
      // never re-derive microsecond arithmetic that would let normal jitter abort the session.
      let previousAnchorOffset = 0
      let previousAnchorTime = frame.captureStartUnixUs
      for (const anchor of frame.captureAnchors) {
        if (!Number.isSafeInteger(anchor.audioOffsetSamples) || anchor.audioOffsetSamples <= previousAnchorOffset
          || anchor.audioOffsetSamples >= FRAME_BYTES / 2
          || !Number.isSafeInteger(anchor.captureUnixUs)
          || anchor.captureUnixUs <= previousAnchorTime || anchor.captureUnixUs >= frame.captureEndUnixUs) {
          this.fail(t('systemAudio.notReady'), 'Malformed native intra-frame source timing anchor')
          return
        }
        previousAnchorOffset = anchor.audioOffsetSamples
        previousAnchorTime = anchor.captureUnixUs
      }
      if (frame.frameSequence <= this.liveLastCaptureFrameSequence) return
      if (frame.frameSequence !== this.liveLastCaptureFrameSequence + 1) {
        this.fail(t('systemAudio.notReady'), 'Native source frame sequence has a gap')
        return
      }
      const previousCaptureEnd = this.liveLastCaptureFrameEndUnixUs
      const frameAudioStartMs = this.liveAudioMs
      if (previousCaptureEnd === null) {
        this.addLiveTimeAnchor(this.liveAudioMs, frame.captureStartUnixUs / 1_000)
      } else {
        const sourceGapUs = frame.captureStartUnixUs - previousCaptureEnd
        if (sourceGapUs > LIVE_CAPTURE_TIME_TOLERANCE_US) {
          if (sourceGapUs >= LIVE_IDLE_CONFIRMATION_US) this.closeLiveGap()
          this.addLiveTimeAnchor(this.liveAudioMs, frame.captureStartUnixUs / 1_000)
        }
      }
      for (const anchor of frame.captureAnchors) {
        this.addLiveTimeAnchor(
          frameAudioStartMs + anchor.audioOffsetSamples * FRAME_MS / (FRAME_BYTES / 2),
          anchor.captureUnixUs / 1_000,
        )
      }
      this.liveLastCaptureFrameSequence = frame.frameSequence
      this.liveLastCaptureFrameEndUnixUs = frame.captureEndUnixUs
    } else if (this.lastFrameAt) {
      const gapMs = now - this.lastFrameAt
      if (gapMs >= FRAME_RECEIVE_GAP_MS) this.closeGap(gapMs)
      else if (this.isSpeechOpen()) noteSpeechFrameGap(gapMs)
    }
    if (this.snapshot.state === 'error') {
      countFrame(audio.byteLength)
      return
    }
    const speechFrame: SpeechFrame = { audio, probability: frame.speechProbability }
    if (this.liveSelected) {
      countFrame(audio.byteLength, { phase: 'listening', segmentMs: this.liveAudioMs })
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
    const voiced = isVoiced(speechFrame)
    // Capture-driven phases must stay out of the way while a queued ASR or translation job is in flight,
    // otherwise the next captured frame immediately hides the stage that stageElapsedMs is timing.
    const processing = this.activeJob !== 0 || this.translating !== null
    if (!this.frames.length && !this.continuation && !voiced) {
      this.preRoll.push(speechFrame)
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
      countFrame(audio.byteLength, processing ? undefined : { phase: 'listening', segmentMs: 0 })
      return
    }
    if (!this.frames.length) {
      this.frames = this.preRoll
      this.preRoll = []
    }
    this.frames.push(speechFrame)
    countFrame(audio.byteLength, processing ? undefined : { phase: 'speech', segmentMs: this.frames.length * FRAME_MS })
    if (voiced) { this.voicedFrames++; this.silenceFrames = 0 } else { this.silenceFrames++ }
    if (this.silenceFrames >= END_SILENCE_FRAMES) this.finishSegment('silence')
    else if (this.frames.length >= this.plan.softFrames && this.silenceFrames >= PAUSE_SPLIT_FRAMES) this.finishSegment('pause')
    else if (this.frames.length >= this.plan.hardFrames) this.splitAtQuietestPoint()
  }

  private resetLiveRecognition() {
    this.liveLastResultId = 0
    this.liveAudioMs = 0
    this.liveTimeAnchors = []
    this.liveLastCaptureFrameSequence = 0
    this.liveLastCaptureFrameEndUnixUs = null
    this.liveLastIdleFrameSequence = -1
    this.liveLastIdleAudioEndUnixUs = -1
    this.liveStableWatermark = 0
    this.liveCommittedWatermark = 0
    this.liveConfirmedText = ''
    this.liveConfirmedStartMs = null
    this.liveConfirmedEndMs = 0
    this.liveConfirmedAt = null
    this.liveInterimText = ''
    this.liveInterimStartMs = null
    this.liveInterimEndMs = 0
    this.livePhraseStartMs = null
    this.livePhraseEngine = ''
    this.livePhraseModel = ''
    this.liveTargetStartMs = 0
    this.liveFinalizedFrontier = -1
    this.liveFinalizeRequests = []
    this.liveLastFinalizeRequest = null
    this.liveFinalizeRetiredThrough = -1
  }

  private addLiveTimeAnchor(audioMs: number, capturedAt: number) {
    const last = this.liveTimeAnchors[this.liveTimeAnchors.length - 1]
    if (last?.audioMs === audioMs) {
      last.capturedAt = capturedAt
      return
    }
    this.liveTimeAnchors.push({ audioMs, capturedAt })
    if (this.liveTimeAnchors.length > MAX_LIVE_TIME_ANCHORS) this.liveTimeAnchors.shift()
  }

  private mapLiveAudioTime(audioMs: number, edge: 'start' | 'end'): number | null {
    for (let index = this.liveTimeAnchors.length - 1; index >= 0; index--) {
      const anchor = this.liveTimeAnchors[index]!
      const applies = edge === 'start' ? anchor.audioMs <= audioMs : anchor.audioMs < audioMs || index === 0
      if (applies) return anchor.capturedAt + audioMs - anchor.audioMs
    }
    return null
  }

  private joinLiveText(left: string, right: string): string {
    const first = left.trim()
    const next = right.trim()
    if (!first) return next
    if (!next) return first
    return `${first}${this.startOptions?.language === 'zh' ? '' : ' '}${next}`
  }

  private liveDisplayText() {
    return this.joinLiveText(this.liveConfirmedText, this.liveInterimText)
  }

  private sendLiveFrame(audio: Uint8Array, generation: number) {
    const live = this.liveSession
    if (!live || !this.liveSelected || generation !== this.generation) return
    try {
      live.sendAudio(audio.buffer as ArrayBuffer)
    } catch (error) {
      this.fail(String(error))
      return
    }
    if (generation !== this.generation || live !== this.liveSession) return
    this.liveAudioMs += FRAME_MS
    const targetMs = this.plan.hardFrames * FRAME_MS
    if (this.liveAudioMs - this.liveTargetStartMs >= targetMs) {
      this.liveTargetStartMs = this.liveAudioMs
      // A target crossing during silence must not flush the stream: Deepgram would finalize a
      // stray word into a phrase of its own. Flush only while speech is actually pending.
      if (this.liveConfirmedText.trim() || this.liveInterimText.trim()) {
        if (this.liveConfirmedText.trim()) this.commitLivePhrase(this.liveConfirmedEndMs, 'cap')
        this.requestLiveFinalize(generation, 'cap')
      }
    }
  }

  private receiveLiveIdle(idle: SystemAudioLiveIdle, generation: number, captureId: number) {
    if (generation !== this.generation || !this.liveSelected || !['starting', 'listening'].includes(this.snapshot.state)
      || idle.sessionId !== captureId || idle.sessionId !== this.captureId) return
    if (!Number.isSafeInteger(idle.frameSequence) || idle.frameSequence < 0) {
      this.fail(t('systemAudio.notReady'), 'Malformed native source idle sequence')
      return
    }
    if (idle.frameSequence < this.liveLastCaptureFrameSequence) return
    if (idle.frameSequence > this.liveLastCaptureFrameSequence) return
    if (!Number.isSafeInteger(idle.confirmedThroughUnixUs)
      || !Number.isSafeInteger(idle.lastAudioCaptureEndUnixUs)
      || idle.lastAudioCaptureEndUnixUs === null
      || idle.confirmedThroughUnixUs < idle.lastAudioCaptureEndUnixUs + LIVE_IDLE_CONFIRMATION_US) {
      this.fail(t('systemAudio.notReady'), 'Malformed native source idle confirmation')
      return
    }
    if (idle.frameSequence === 0 && this.liveLastCaptureFrameEndUnixUs === null) return
    if (!Number.isSafeInteger(idle.lastFrameCaptureEndUnixUs)
      || idle.lastFrameCaptureEndUnixUs === null
      || idle.lastFrameCaptureEndUnixUs !== this.liveLastCaptureFrameEndUnixUs
      || idle.lastAudioCaptureEndUnixUs < idle.lastFrameCaptureEndUnixUs) {
      this.fail(t('systemAudio.notReady'), 'Native source idle confirmation does not match the frame frontier')
      return
    }
    if (idle.frameSequence < this.liveLastIdleFrameSequence
      || (idle.frameSequence === this.liveLastIdleFrameSequence
        && idle.lastAudioCaptureEndUnixUs <= this.liveLastIdleAudioEndUnixUs)) return
    this.liveLastIdleFrameSequence = idle.frameSequence
    this.liveLastIdleAudioEndUnixUs = idle.lastAudioCaptureEndUnixUs
    this.closeLiveGap()
  }

  private receiveLiveResult(generation: number, result: LiveAsrResult) {
    if (generation !== this.generation || !this.liveSelected || this.liveSessionId !== result.sessionId
      || result.resultId <= this.liveLastResultId) return
    if (!Number.isFinite(result.audioStartMs) || !Number.isFinite(result.audioEndMs)
      || result.audioStartMs < 0 || result.audioEndMs < result.audioStartMs || typeof result.text !== 'string') {
      this.fail(t('systemAudio.notReady'), 'Invalid live recognition range')
      return
    }
    this.liveLastResultId = result.resultId
    const matchedFinalizeRequest = result.fromFinalize ? this.findLiveFinalizeRequest(result.audioEndMs) : null
    if (result.audioEndMs <= this.liveCommittedWatermark
      || result.audioStartMs < this.liveCommittedWatermark) return

    let changed = false
    const text = result.text.trim()
    if (result.isFinal) {
      if (result.audioStartMs >= this.liveStableWatermark && result.audioEndMs > this.liveStableWatermark) {
        this.liveStableWatermark = result.audioEndMs
        if (text) {
          if (this.livePhraseStartMs === null) {
            this.livePhraseStartMs = result.audioStartMs
            this.livePhraseEngine = result.asrEngine
            this.livePhraseModel = result.asrModel
          }
          this.liveConfirmedStartMs ??= result.audioStartMs
          this.liveConfirmedText = this.joinLiveText(this.liveConfirmedText, text)
          this.liveConfirmedEndMs = result.audioEndMs
          this.liveConfirmedAt = Date.now()
        }
        if (this.liveInterimStartMs !== null && this.liveInterimStartMs < this.liveStableWatermark) {
          this.liveInterimText = ''
          this.liveInterimStartMs = null
          this.liveInterimEndMs = 0
        }
        changed = true
      }
    } else if (result.audioStartMs >= this.liveStableWatermark && result.audioEndMs > this.liveStableWatermark) {
      this.liveInterimText = text
      this.liveInterimStartMs = result.audioStartMs
      this.liveInterimEndMs = result.audioEndMs
      if (this.livePhraseStartMs === null) {
        this.livePhraseStartMs = result.audioStartMs
        this.livePhraseEngine = result.asrEngine
        this.livePhraseModel = result.asrModel
      }
      changed = true
    }

    if (new TextEncoder().encode(this.liveDisplayText()).byteLength > MAX_LIVE_PHRASE_BYTES) {
      this.fail(t('systemAudio.livePhraseOverflow'))
      return
    }
    const finalizeRequest = matchedFinalizeRequest ?? (result.fromFinalize ? this.liveLastFinalizeRequest : null)
    const fromFinalizeWithMetadata = result.fromFinalize && finalizeRequest !== null
    if ((result.speechFinal || fromFinalizeWithMetadata)
      && result.audioEndMs > this.liveCommittedWatermark
      && result.audioEndMs >= this.liveStableWatermark
      && (this.livePhraseStartMs === null || result.audioEndMs > this.livePhraseStartMs)) {
      if (matchedFinalizeRequest) this.consumeLiveFinalizeRequest(matchedFinalizeRequest)
      const closeReason = finalizeRequest?.closeReason ?? (result.fromFinalize ? 'gap' : 'silence')
      const targetStartMs = finalizeRequest?.closeReason === 'cap'
        ? finalizeRequest.targetStartMs
        : result.speechFinal ? result.audioEndMs : this.liveAudioMs
      this.commitLivePhrase(result.audioEndMs, closeReason, targetStartMs)
      return
    }
    if (changed) this.publish({ liveOriginal: this.liveDisplayText() })
  }

  private commitLivePhrase(boundaryAudioMs: number, closeReason: SegmentCloseReason, targetStartMs = this.liveAudioMs) {
    if (boundaryAudioMs <= this.liveCommittedWatermark) return
    const text = this.liveConfirmedText.trim()
    const startAudioMs = this.liveConfirmedStartMs
    const endAudioMs = text && this.liveConfirmedEndMs > 0 ? this.liveConfirmedEndMs : boundaryAudioMs
    const generation = this.generation
    let job: TranslationJob | null = null
    let recognitionOnlyResult: {
      caption: string
      phraseId: number
      runId: number | null
      finishDetails: PipelineFinishDetails
    } | null = null

    if (text && startAudioMs !== null) {
      const startedAt = this.mapLiveAudioTime(startAudioMs, 'start')
      const endedAt = this.mapLiveAudioTime(endAudioMs, 'end')
      if (startedAt === null || endedAt === null) {
        this.fail(t('systemAudio.liveTimingUnavailable'))
        return
      }
      const sourceSpan = { startedAt, endedAt: Math.max(startedAt, endedAt) }
      const context = this.translationContext(sourceSpan)
      const phraseId = ++sequence
      const asrMs = Math.max(0, (this.liveConfirmedAt ?? Date.now()) - sourceSpan.endedAt)
      const speechMs = Math.max(0, sourceSpan.endedAt - sourceSpan.startedAt)
      const asrEngine = this.livePhraseEngine || 'deepgram'
      const asrModel = this.livePhraseModel
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
        }
      }
    }

    this.liveCommittedWatermark = Math.max(this.liveCommittedWatermark, boundaryAudioMs)
    this.liveConfirmedText = ''
    this.liveConfirmedStartMs = null
    this.liveConfirmedEndMs = 0
    this.liveConfirmedAt = null
    if (this.liveInterimStartMs === null || this.liveInterimEndMs <= boundaryAudioMs) {
      this.liveInterimText = ''
      this.liveInterimStartMs = null
      this.liveInterimEndMs = 0
    }
    this.livePhraseStartMs = this.liveInterimStartMs
    if (this.livePhraseStartMs === null) {
      this.livePhraseEngine = ''
      this.livePhraseModel = ''
    }
    this.liveTargetStartMs = targetStartMs
    const liveOriginal = this.liveDisplayText()
    if (recognitionOnlyResult) {
      this.publish({
        caption: recognitionOnlyResult.caption,
        captionNotice: '',
        source: '',
        warning: this.currentWarning(),
        liveOriginal,
      }, recognitionOnlyResult.runId, recognitionOnlyResult.finishDetails)
      this.holdCaption(generation, recognitionOnlyResult.phraseId)
    } else {
      this.publish({ liveOriginal })
    }
    if (job) {
      this.enqueueTranslation(job)
      this.pumpTranslation()
    }
  }

  private requestLiveFinalize(generation: number, reason: SegmentCloseReason) {
    const live = this.liveSession
    const frontier = this.liveAudioMs
    if (!live || frontier <= this.liveFinalizedFrontier) return
    const request: LiveFinalizeRequest = {
      afterFrontierMs: this.liveFinalizedFrontier,
      frontierMs: frontier,
      closeReason: reason,
      targetStartMs: this.liveTargetStartMs,
    }
    if (this.liveFinalizeRequests.length >= MAX_LIVE_FINALIZE_REQUESTS) {
      const retired = this.liveFinalizeRequests.shift()!
      this.liveFinalizeRetiredThrough = Math.max(this.liveFinalizeRetiredThrough, retired.frontierMs)
    }
    this.liveFinalizeRequests.push(request)
    this.liveLastFinalizeRequest = request
    this.liveFinalizedFrontier = frontier
    void live.finalize().catch((error: unknown) => {
      if (generation === this.generation && live === this.liveSession) this.fail(String(error))
    })
  }

  private findLiveFinalizeRequest(audioEndMs: number) {
    // Results have no request ID; match only their audio window and never shift a later result into an expired one.
    if (audioEndMs <= this.liveFinalizeRetiredThrough) return null
    return this.liveFinalizeRequests.find((request) =>
      audioEndMs > request.afterFrontierMs && audioEndMs <= request.frontierMs)
      ?? null
  }

  private consumeLiveFinalizeRequest(request: LiveFinalizeRequest) {
    const index = this.liveFinalizeRequests.indexOf(request)
    if (index < 0) return
    this.liveFinalizeRequests.splice(0, index + 1)
    this.liveFinalizeRetiredThrough = Math.max(this.liveFinalizeRetiredThrough, request.frontierMs)
  }

  private closeLiveGap() {
    if (!this.liveSelected) return
    if (this.liveConfirmedText) this.commitLivePhrase(this.liveConfirmedEndMs, 'gap')
    if (this.liveAudioMs > this.liveFinalizedFrontier) {
      this.requestLiveFinalize(this.generation, 'gap')
    }
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

  // A speech segment is open while it holds frames, or while the one before it was cut mid-speech.
  private isSpeechOpen() {
    return this.frames.length > 0 || this.continuation
  }

  // The segment hit its hard cap without a phrase boundary. Cut at the quietest point of the tail window and
  // carry the frames after it into the next segment, so a word is not severed on an arbitrary frame.
  private splitAtQuietestPoint() {
    const keep = chooseForcedSplit(this.frames.map((frame) => frame.probability), this.plan.softFrames)
    this.finishSegment('cap', this.frames.splice(keep))
  }

  // No frame arrived for `gapMs`: either playback stopped or frame delivery stalled. The two look the same here, but
  // the last frame tells them apart for diagnostics: a voiced one means speech was cut off mid-way.
  private closeGap(gapMs: number) {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
    if (this.liveSelected) {
      this.closeLiveGap()
      this.preRoll = []
      this.lastFrameAt = 0
      return
    }
    if (this.isSpeechOpen()) noteSpeechFrameGap(gapMs)
    const last = this.frames[this.frames.length - 1]
    this.finishSegment(last && isVoiced(last) ? 'dropout' : 'gap')
    this.preRoll = []
    this.lastFrameAt = 0
  }

  // `carry` holds frames that were captured after the cut point and open the next segment. A pause or length-limit
  // cut means speech is still going on, so the next segment continues it; every other reason ends the utterance.
  private finishSegment(reason: SegmentCloseReason, carry: SpeechFrame[] = []) {
    const eligible = this.voicedFrames >= MIN_VOICED_FRAMES || (this.continuation && this.voicedFrames > 0)
    const frames = this.frames
    this.frames = carry
    this.voicedFrames = carry.filter(isVoiced).length
    this.silenceFrames = 0
    while (this.silenceFrames < carry.length && !isVoiced(carry[carry.length - 1 - this.silenceFrames])) this.silenceFrames++
    this.continuation = (reason === 'pause' || reason === 'cap') && eligible
    if (!eligible || !frames.length) return
    // A short continuation still contains real speech; pad only the submitted job to the ASR minimum.
    const audio = new Uint8Array(Math.max(10, frames.length) * FRAME_BYTES)
    frames.forEach((frame, index) => audio.set(frame.audio, index * FRAME_BYTES))
    this.dropOldestToFit(audio.byteLength)
    const runId = beginRun({ mode: this.provider?.mode ?? 'unknown', speechMs: frames.length * FRAME_MS, closeReason: reason, asrOnly: this.options?.asrOnly ?? false })
    const endedAt = Date.now()
    this.queue.push({ audio, runId, startedAt: endedAt - frames.length * FRAME_MS, endedAt })
    this.queuedBytes += audio.byteLength
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

  private enqueueTranslation(result: FinalResult | TranslationJob): void {
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
        onPartial: (text) => this.publishPartialTranslation(job, text, generation),
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
    if (!this.publishTranslationOutcome(outcome, job.runId, generation, job.phraseId)) return
    if (!this.activeJob) setPipelineActivity({ phase: 'listening', stageStartedAt: null })
    this.pumpTranslation()
  }

  private resetSegment() {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
    this.frames = []
    this.preRoll = []
    this.voicedFrames = this.silenceFrames = this.lastFrameAt = 0
    this.continuation = false
  }

  private clearWork(preserveWarnings = false) {
    this.resetSegment()
    for (const timer of [this.processingTimer, this.captionTimer]) if (timer) clearTimeout(timer)
    this.processingTimer = this.captionTimer = null
    this.settledCaptionPhraseId = null
    if (this.activeRunId !== null) {
      failRun(this.activeRunId, 'cancelled')
      this.activeRunId = null
    }
    this.queue.forEach(({ runId }) => failRun(runId, 'cancelled'))
    this.queue = []
    if (this.translating) {
      failRun(this.translating.runId, 'cancelled')
      this.translating = null
    }
    this.translations.forEach(({ runId }) => failRun(runId, 'cancelled'))
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
    this.resetLiveRecognition()
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
  overlay: {
    present: presentSubtitleOverlay,
    update: updateSubtitleOverlay,
    hide: hideSubtitleOverlay,
  },
})

if (import.meta.hot) import.meta.hot.dispose(() => { void systemAudioSession.stop() })

import * as bridge from './bridge'
import { t } from '@/i18n'
import { getPromptPresets, getSetting, TRANSLATION_PRESET_PREFIX } from './store'
import { normalizeSpeechInputLanguage, type SpeechInputLanguage } from './speechInputLanguage'
import { chooseForcedSplit, DEFAULT_SEGMENT_SECONDS, FRAME_MS, normalizeSegmentSeconds, segmentPlan, type SegmentPlan } from './subtitleSegmentation'
import { buildSubtitlePrompt, RecentSpeech, SUBTITLE_CONTEXT_SOURCE, subtitleLanguageName } from './subtitleTranslation'
import { addRuntimeEvent } from './debugLog'
import { describeProviderError } from '@/lib/errorMessages'
import type { FinalResult, StartOptions, TranscriptionProvider } from './transcription/types'
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
  startedAt: number
  endedAt: number
}

interface SegmentJob extends SegmentSpan {
  audio: Uint8Array
  runId: number | null
}

/** One recognized segment waiting for, or undergoing, client-side translation. */
interface TranslationJob {
  runId: number | null
  asrText: string
  asrMs: number
  durationSec: number
  speechMs: number
  context?: TextContext
  asrEngine?: string
  asrModel?: string
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
// Every caption-bound field of the snapshot; reset together so a notice or original never outlives its caption.
const NO_CAPTION = { caption: '', captionNotice: '', source: '' } as const
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

  private snapshot: SystemAudioSnapshot = { state: 'idle', ...NO_CAPTION, error: '', warning: '' }
  private readonly listeners = new Set<() => void>()
  private generation = 0
  private leased = false
  private provider: TranscriptionProvider | null = null
  private localModelId = ''
  private options: { deviceId: string; targetLanguage: SubtitleTargetLanguage; asrOnly: boolean } | null = null
  private startOptions: Omit<StartOptions, 'runId'> | null = null
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private captureId = 0
  private captureStop: Promise<void> = Promise.resolve()
  private unlisteners: Array<() => void> = []
  private overlayUpdates: Promise<void> = Promise.resolve()
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
  private activeContext: TextContext | undefined
  private activeSplit = false
  private readonly recent = new RecentSpeech()
  private publishedAsrJob = 0
  private activeRunId: number | null = null
  private lastFrameAt = 0
  private gapTimer: ReturnType<typeof setTimeout> | null = null
  private processingTimer: ReturnType<typeof setTimeout> | null = null
  private captionTimer: ReturnType<typeof setTimeout> | null = null

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
    const generation = this.generation
    const payload = this.overlayPayload()
    this.overlayUpdates = this.overlayUpdates.then(async () => {
      let overlayMs: number | null = null
      if (generation === this.generation && this.leased) {
        const traceOverlay = traceRunId !== null && isPipelineDebugEnabled()
        const overlayStartedAt = traceOverlay ? Date.now() : 0
        try {
          await this.dependencies.overlay.update(payload)
          if (traceOverlay) overlayMs = Math.max(0, Date.now() - overlayStartedAt)
        } catch (error) {
          if (traceRunId !== null && isPipelineDebugEnabled()) failRun(traceRunId, 'failed', String(error))
          throw error
        }
      }
      if (traceRunId !== null && isPipelineDebugEnabled()) finishRun(traceRunId, { ...finishDetails, overlayMs })
    })
  }

  private overlayPayload(): SubtitleOverlayPayload {
    return {
      subtitleText: this.snapshot.caption,
      // The steady "listening" label only sits on top of the video; every other state is named, and a warning replaces it.
      subtitleStatus: this.snapshot.warning || (this.snapshot.state === 'listening' ? '' : t(`systemAudio.status.${this.snapshot.state}`)),
      subtitleError: this.snapshot.error,
      subtitleNotice: this.snapshot.captionNotice,
      subtitleSource: this.snapshot.source,
    }
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
  private publishTranslationOutcome(result: FinalResult, runId: number | null, generation: number): boolean {
    const original = result.asrText.trim()
    const comparableTranslation = result.llmText.replace(/\s+/g, ' ').trim()
    const comparableSource = result.asrText.replace(/\s+/g, ' ').trim()
    if (result.aiStatus !== 'applied' || !comparableTranslation) {
      // The AI produced no translation. Show what was heard, marked as untranslated, and keep listening.
      failRun(runId, 'rejected', result.aiStatus !== 'applied' ? result.aiStatus : 'empty translation')
      if (this.recordFailure(t('systemAudio.translationFailed'))) return false
      this.publishCaption(original, generation, undefined, undefined, t('systemAudio.untranslated'))
      return true
    }
    this.consecutiveFailures = 0
    const caption = result.llmText.trim()
    const traceRunId = isPipelineDebugEnabled() ? runId : null
    // A translation identical to the transcript is speech already in the target language, a name, a number,
    // or an AI echoing its input when its answer was empty. Never present it as a translation.
    const identical = comparableTranslation === comparableSource
    this.publishCaption(caption, generation, traceRunId, traceRunId === null ? undefined : this.finishDetails(result, caption),
      identical ? t('systemAudio.untranslated') : '', this.dual && !identical ? original : '')
    return true
  }

  private publishCaption(caption: string, generation: number, runId?: number | null, finishDetails?: PipelineFinishDetails, captionNotice = '', source = '') {
    const change = { caption, warning: '', captionNotice, source }
    if (runId !== undefined && runId !== null && finishDetails) this.publish(change, runId, finishDetails)
    else this.publish(change)
    this.holdCaption(generation)
  }

  // Dual-subtitle mode shows the recognized original while its translation is still pending. The previous caption is
  // dropped with it, so the original is never paired with the translation of the fragment before.
  private publishSource(source: string, generation: number) {
    this.publish({ caption: '', captionNotice: '', source })
    this.holdCaption(generation)
  }

  private holdCaption(generation: number) {
    if (this.captionTimer) clearTimeout(this.captionTimer)
    this.captionTimer = setTimeout(() => {
      if (generation === this.generation) this.publish(NO_CAPTION)
    }, CAPTION_HOLD_MS)
  }

  async start(options: { deviceId: string; targetLanguage: SubtitleTargetLanguage; asrOnly?: boolean }): Promise<void> {
    if (this.snapshot.state !== 'idle') return
    this.options = { ...options, asrOnly: options.asrOnly ?? false }
    await this.begin()
  }

  private async begin() {
    const generation = ++this.generation
    this.publish({ state: 'starting', ...NO_CAPTION, error: '', warning: '' })
    const operation = this.open(generation)
    this.starting = operation
    try { await operation } finally { if (this.starting === operation) this.starting = null }
  }

  private async open(generation: number) {
    try {
      if (!this.leased) {
        await this.dependencies.acquire()
        this.leased = true
      }
      if (generation !== this.generation) return
      const asrOnly = this.options!.asrOnly
      const [presets, language, hotwords, maxSegmentSeconds, dual] = await Promise.all([
        asrOnly ? Promise.resolve([]) : getPromptPresets(), getSystemAudioSourceLanguage(), loadActiveHotwords(), getSystemAudioMaxSegmentSeconds(), getSystemAudioDualSubtitles(),
      ])
      if (generation !== this.generation) return
      this.plan = segmentPlan(maxSegmentSeconds)
      // Recognition-only mode already shows the recognized text as its caption.
      this.dual = dual && !asrOnly
      if (asrOnly) {
        this.startOptions = { systemPrompt: '', language, hotwords, disableAi: true, aiMinDurationSec: 0, requireTranslation: false }
      } else {
        // The translate_* presets only define which target languages exist; subtitles use their own prompt.
        const targetLanguage = this.options!.targetLanguage
        if (!presets.some((preset) => preset.id === `${TRANSLATION_PRESET_PREFIX}${targetLanguage}`)) throw new Error(t('systemAudio.notReady'))
        this.startOptions = { systemPrompt: buildSubtitlePrompt(subtitleLanguageName(targetLanguage)), language, hotwords, disableAi: false, aiMinDurationSec: 0, requireTranslation: true }
      }
      this.provider = this.dependencies.getProvider()
      this.localModelId = this.provider.mode === 'local' ? await getSetting('localAsr.modelId', '') : ''
      if (generation !== this.generation) return
      await this.provider.connect({
        onReady: (ready) => {
          if (generation !== this.generation) return
          if (!ready.asr || (!asrOnly && this.provider?.mode === 'server' && !ready.llm)) this.fail(t('systemAudio.notReady'))
        },
        onASR: (result) => {
          if (generation !== this.generation || !this.activeJob) return
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
      })
      if (generation !== this.generation) return
      if (!this.provider.isReady()) throw new Error(t('systemAudio.notReady'))
      const showId = await this.dependencies.overlay.present(this.overlayPayload())
      if (generation !== this.generation) return
      if (!showId) throw new Error(t('systemAudio.captureFailed'))
      for (const [event, handler] of [
        ['system-audio-frame', (payload: unknown) => this.receiveFrame(payload as SystemAudioFrame)],
        ['system-audio-error', (payload: unknown) => {
          const error = payload as { sessionId: number; message: string }
          if (error.sessionId === this.captureId) this.fail(t('systemAudio.captureFailed'), error.message)
        }],
      ] as const) {
        const unlisten = await bridge.listen<unknown>(event, (data) => {
          if (generation === this.generation) handler(data.payload)
        })
        if (generation !== this.generation) { unlisten(); return }
        this.unlisteners.push(unlisten)
      }
      const captureId = ++sequence
      this.captureId = captureId
      await bridge.invoke('start_system_audio_capture', { sessionId: captureId, deviceId: this.options!.deviceId || null })
      if (generation !== this.generation) {
        await bridge.invoke('stop_system_audio_capture', { sessionId: captureId })
        return
      }
      this.publish({ state: 'listening' })
      setPipelineActivity({ phase: 'listening', segmentMs: 0, stageStartedAt: null })
    } catch (error) {
      if (generation === this.generation) {
        this.fail(!this.leased ? t('systemAudio.busy') : this.captureId ? t('systemAudio.captureFailed') : t('systemAudio.notReady'), String(error))
      }
    }
  }

  private receiveFrame(frame: SystemAudioFrame) {
    if (frame.sessionId !== this.captureId || !['starting', 'listening'].includes(this.snapshot.state)) return
    let audio: Uint8Array
    try {
      audio = Uint8Array.from(atob(frame.audioB64), (char) => char.charCodeAt(0))
      if (audio.byteLength !== FRAME_BYTES || !Number.isFinite(frame.speechProbability)) throw new Error('Invalid system-audio frame')
    } catch (error) { this.fail(t('systemAudio.captureFailed'), String(error)); return }

    if (frame.discontinuity) {
      countDiscontinuity()
      this.resetSegment()
      this.publish({ ...NO_CAPTION, warning: t('systemAudio.discontinuity') })
      addRuntimeEvent('warn', 'system-audio', 'Audio gap; unfinished speech discarded, listening continues')
    }

    const now = Date.now()
    if (this.lastFrameAt) {
      const gapMs = now - this.lastFrameAt
      if (gapMs >= FRAME_RECEIVE_GAP_MS) this.closeGap(gapMs)
      else if (this.isSpeechOpen()) noteSpeechFrameGap(gapMs)
    }
    if (this.snapshot.state === 'error') {
      countFrame(audio.byteLength)
      return
    }
    this.lastFrameAt = now
    if (this.gapTimer) clearTimeout(this.gapTimer)
    const generation = this.generation
    // Measure from the last frame, so a timer that fires late (a frozen event loop) still reports the real stall.
    this.gapTimer = setTimeout(() => {
      if (generation !== this.generation) return
      this.closeGap(Date.now() - this.lastFrameAt)
    }, FRAME_RECEIVE_GAP_MS)

    const speechFrame: SpeechFrame = { audio, probability: frame.speechProbability }
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
    if (dropped) this.publish({ warning: t('systemAudio.behind') })
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
    this.publish({ warning: t('systemAudio.fragmentSkipped', { reason }) })
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

  private enqueueTranslation(result: FinalResult): void {
    const speechMs = this.activeSpan ? Math.max(0, this.activeSpan.endedAt - this.activeSpan.startedAt) : 0
    this.translations.push({
      runId: this.activeRunId,
      asrText: result.asrText,
      asrMs: result.asrMs,
      durationSec: result.durationSec,
      speechMs,
      context: this.activeContext,
      asrEngine: result.asrEngine,
      asrModel: result.asrModel,
    })
    this.translationBacklogMs += speechMs
    // Translations older than the speech now playing are worthless; drop the oldest waiting ones to bound the
    // backlog, mirroring dropOldestToFit, and keep listening.
    let dropped = false
    while (this.translations.length && this.translationBacklogMs > MAX_TRANSLATION_BACKLOG_MS) {
      const oldest = this.translations.shift()!
      this.translationBacklogMs -= oldest.speechMs
      failRun(oldest.runId, 'failed', 'dropped: translation is behind playback')
      dropped = true
    }
    if (dropped) this.publish({ warning: t('systemAudio.behind') })
    this.publishQueueDepth()
  }

  // One translation at a time, in speech order: captions must follow each other the way they were spoken.
  private pumpTranslation(): void {
    if (this.translating || !this.translations.length || !['starting', 'listening'].includes(this.snapshot.state)) return
    const job = this.translations.shift()!
    this.translationBacklogMs = Math.max(0, this.translationBacklogMs - job.speechMs)
    this.publishQueueDepth()
    this.translating = job
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
    if (!this.publishTranslationOutcome(outcome, job.runId, generation)) return
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

  private clearWork() {
    this.resetSegment()
    for (const timer of [this.processingTimer, this.captionTimer]) if (timer) clearTimeout(timer)
    this.processingTimer = this.captionTimer = null
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
    this.queuedBytes = this.activeJob = 0
    this.publishedAsrJob = 0
    setQueueDepth(0)
    setPipelineActivity({ phase: 'idle', segmentMs: 0, stageStartedAt: null })
    this.unlisteners.splice(0).forEach((unlisten) => unlisten())
    this.provider?.disconnect()
  }

  private stopNativeCapture() {
    const captureId = this.captureId
    if (!captureId) return this.captureStop
    const stop = async () => {
      await bridge.invoke<void>('stop_system_audio_capture', { sessionId: captureId })
      if (this.captureId === captureId) this.captureId = 0
    }
    // A failed stop keeps its capture id and lease, so an explicit Stop can retry cleanup.
    this.captureStop = this.captureStop.then(stop, stop)
    return this.captureStop
  }

  private fail(message: string, detail?: string) {
    if (this.snapshot.state === 'error' || this.snapshot.state === 'stopping') return
    if (this.activeRunId !== null) {
      failRun(this.activeRunId, 'failed', message)
      this.activeRunId = null
    }
    const generation = ++this.generation
    this.clearWork()
    this.publish({ state: 'error', ...NO_CAPTION, error: message, warning: '' })
    addRuntimeEvent('warn', 'system-audio', 'Subtitle session interrupted', { message, detail })
    void this.stopNativeCapture().catch((error) => {
      addRuntimeEvent('error', 'system-audio', 'Capture cleanup failed', { error: String(error) })
      // Keep the interruption cause visible: cleanup failure is additional context, not a replacement.
      if (generation !== this.generation) return
      this.publish({ error: `${message} ${t('systemAudio.cleanupFailed')}` })
    })
  }

  async pause(): Promise<void> {
    if (this.snapshot.state !== 'listening') return
    ++this.generation
    this.clearWork()
    this.publish({ state: 'paused', ...NO_CAPTION, warning: '' })
    try { await this.stopNativeCapture() } catch (error) { this.fail(t('systemAudio.cleanupFailed'), String(error)) }
  }

  async resume(): Promise<void> {
    if (!['paused', 'error'].includes(this.snapshot.state) || !this.options || this.stopping) return
    await this.starting
    try { await this.captureStop } catch { this.publish({ error: t('systemAudio.cleanupFailed') }); return }
    if (!['paused', 'error'].includes(this.snapshot.state)) return
    this.clearWork()
    await this.begin()
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    if (this.snapshot.state === 'idle') return
    ++this.generation
    this.publish({ state: 'stopping', ...NO_CAPTION, error: '', warning: '' })
    this.clearWork()
    const operation = this.release()
    this.stopping = operation
    try { await operation } finally { if (this.stopping === operation) this.stopping = null }
  }

  private async release() {
    try {
      await this.starting
      await this.stopNativeCapture()
      this.clearWork()
      await this.overlayUpdates
      if (this.leased) {
        await this.dependencies.overlay.hide()
        await this.dependencies.release()
        this.leased = false
      }
      this.provider = null
      this.publish({ state: 'idle', ...NO_CAPTION, error: '', warning: '' })
    } catch (error) {
      this.publish({ state: 'error', error: t('systemAudio.cleanupFailed') })
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

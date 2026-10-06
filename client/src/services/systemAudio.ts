import * as bridge from './bridge'
import { t } from '@/i18n'
import { getPromptPresets, getSetting, TRANSLATION_PRESET_PREFIX } from './store'
import { normalizeSpeechInputLanguage, type SpeechInputLanguage } from './speechInputLanguage'
import { chooseForcedSplit, DEFAULT_SEGMENT_SECONDS, FRAME_MS, normalizeSegmentSeconds, segmentPlan, type SegmentPlan } from './subtitleSegmentation'
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
  setPipelineActivity,
  setQueueDepth,
} from './pipelineTrace'
import {
  acquireSystemAudio,
  hideSubtitleOverlay,
  presentSubtitleOverlay,
  releaseSystemAudio,
  updateSubtitleOverlay,
} from './recorder'
import { getProvider } from './transcription'
import { loadActiveHotwords } from './hotwords/settings'
import type { SubtitleOverlayPayload } from './recorder/types'

// Targets are owned by the builtin translate_* presets in store.ts; sessions validate them by preset id lookup.
export type SubtitleTargetLanguage = string
export type SystemAudioState = 'idle' | 'starting' | 'listening' | 'paused' | 'stopping' | 'error'

export interface SystemAudioSnapshot {
  state: SystemAudioState
  caption: string
  error: string
  warning: string
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
const CAPTION_HOLD_MS = 8_000
let sequence = Date.now()

export async function getSystemAudioSourceLanguage(): Promise<SpeechInputLanguage> {
  return normalizeSpeechInputLanguage(await getSetting('systemAudio.sourceLanguage', 'auto'))
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

  private snapshot: SystemAudioSnapshot = { state: 'idle', caption: '', error: '', warning: '' }
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
  private voicedFrames = 0
  private silenceFrames = 0
  private continuation = false
  private queue: SegmentJob[] = []
  private queuedBytes = 0
  private activeJob = 0
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
      subtitleStatus: this.snapshot.warning || t(`systemAudio.status.${this.snapshot.state}`),
      subtitleError: this.snapshot.error,
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

  private publishCaption(caption: string, generation: number, runId?: number | null, finishDetails?: PipelineFinishDetails) {
    if (this.captionTimer) clearTimeout(this.captionTimer)
    if (runId !== undefined && runId !== null && finishDetails) this.publish({ caption, warning: '' }, runId, finishDetails)
    else this.publish({ caption, warning: '' })
    this.captionTimer = setTimeout(() => {
      if (generation === this.generation) this.publish({ caption: '' })
    }, CAPTION_HOLD_MS)
  }

  async start(options: { deviceId: string; targetLanguage: SubtitleTargetLanguage; asrOnly?: boolean }): Promise<void> {
    if (this.snapshot.state !== 'idle') return
    this.options = { ...options, asrOnly: options.asrOnly ?? false }
    await this.begin()
  }

  private async begin() {
    const generation = ++this.generation
    this.publish({ state: 'starting', caption: '', error: '', warning: '' })
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
      const [presets, language, hotwords, maxSegmentSeconds] = await Promise.all([
        asrOnly ? Promise.resolve([]) : getPromptPresets(), getSystemAudioSourceLanguage(), loadActiveHotwords(), getSystemAudioMaxSegmentSeconds(),
      ])
      if (generation !== this.generation) return
      this.plan = segmentPlan(maxSegmentSeconds)
      if (asrOnly) {
        this.startOptions = { systemPrompt: '', language, hotwords, disableAi: true, aiMinDurationSec: 0, requireTranslation: false }
      } else {
        const prompt = presets.find((preset) => preset.id === `${TRANSLATION_PRESET_PREFIX}${this.options!.targetLanguage}`)?.systemPrompt
        if (!prompt?.trim()) throw new Error(t('systemAudio.notReady'))
        this.startOptions = { systemPrompt: prompt, language, hotwords, disableAi: false, aiMinDurationSec: 0, requireTranslation: true }
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
          // The managed server LLM falls back to the input text when its answer is empty or
          // think-only while still reporting elapsed time, so an "applied" result can be the
          // original speech. A translation identical to the transcript is never shown as one.
          const comparableTranslation = result.llmText.replace(/\s+/g, ' ').trim()
          const comparableSource = result.asrText.replace(/\s+/g, ' ').trim()
          if (result.aiStatus !== 'applied' || !comparableTranslation || comparableTranslation === comparableSource) {
            failRun(this.activeRunId, 'rejected', result.aiStatus !== 'applied' ? result.aiStatus : 'identical translation')
            this.fail(t('systemAudio.translationFailed'))
            return
          }
          const caption = result.llmText.trim()
          const runId = isPipelineDebugEnabled() ? this.activeRunId : null
          this.publishCaption(caption, generation, runId, runId === null ? undefined : this.finishDetails(result, caption))
        },
        onDone: () => {
          if (generation !== this.generation || !this.activeJob) return
          setPipelineActivity({ phase: 'listening', stageStartedAt: null })
          this.activeJob = 0
          this.publishedAsrJob = 0
          this.activeRunId = null
          if (this.processingTimer) clearTimeout(this.processingTimer)
          this.processingTimer = null
          // Providers finalize their run after onDone returns. Never start a new run inside that callback.
          queueMicrotask(() => { if (generation === this.generation) this.processNext() })
        },
        onError: (message) => {
          if (generation === this.generation) this.fail(describeProviderError(message).message)
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
      this.publish({ caption: '', warning: t('systemAudio.discontinuity') })
      addRuntimeEvent('warn', 'system-audio', 'Audio gap; unfinished speech discarded, listening continues')
    }

    const now = Date.now()
    if (this.lastFrameAt && now - this.lastFrameAt >= FRAME_RECEIVE_GAP_MS) this.closeGap()
    if (this.snapshot.state === 'error') {
      countFrame(audio.byteLength)
      return
    }
    this.lastFrameAt = now
    if (this.gapTimer) clearTimeout(this.gapTimer)
    const generation = this.generation
    this.gapTimer = setTimeout(() => { if (generation === this.generation) this.closeGap() }, FRAME_RECEIVE_GAP_MS)

    const speechFrame: SpeechFrame = { audio, probability: frame.speechProbability }
    const voiced = isVoiced(speechFrame)
    // Capture-driven phases must stay out of the way while a queued ASR or translation job is in flight,
    // otherwise the next captured frame immediately hides the stage that stageElapsedMs is timing.
    const processing = this.activeJob !== 0
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
    if (this.silenceFrames >= END_SILENCE_FRAMES) this.finishSegment(false)
    else if (this.frames.length >= this.plan.softFrames && this.silenceFrames >= PAUSE_SPLIT_FRAMES) this.finishSegment(true)
    else if (this.frames.length >= this.plan.hardFrames) this.splitAtQuietestPoint()
  }

  // The segment hit its hard cap without a phrase boundary. Cut at the quietest point of the tail window and
  // carry the frames after it into the next segment, so a word is not severed on an arbitrary frame.
  private splitAtQuietestPoint() {
    const keep = chooseForcedSplit(this.frames.map((frame) => frame.probability), this.plan.softFrames)
    this.finishSegment(true, this.frames.splice(keep))
  }

  private closeGap() {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
    this.finishSegment(false)
    this.preRoll = []
    this.lastFrameAt = 0
  }

  // `split` means speech is still going on, so the next segment continues it. `carry` holds frames that were
  // captured after the cut point and open that next segment.
  private finishSegment(split: boolean, carry: SpeechFrame[] = []) {
    const eligible = this.voicedFrames >= MIN_VOICED_FRAMES || (this.continuation && this.voicedFrames > 0)
    const frames = this.frames
    this.frames = carry
    this.voicedFrames = carry.filter(isVoiced).length
    this.silenceFrames = 0
    while (this.silenceFrames < carry.length && !isVoiced(carry[carry.length - 1 - this.silenceFrames])) this.silenceFrames++
    this.continuation = split && eligible
    if (!eligible || !frames.length) return
    // A short continuation still contains real speech; pad only the submitted job to the ASR minimum.
    const audio = new Uint8Array(Math.max(10, frames.length) * FRAME_BYTES)
    frames.forEach((frame, index) => audio.set(frame.audio, index * FRAME_BYTES))
    if (this.queuedBytes + audio.byteLength > MAX_PENDING_BYTES) { this.fail(t('systemAudio.overload')); return }
    const runId = beginRun({ mode: this.provider?.mode ?? 'unknown', speechMs: frames.length * FRAME_MS, asrOnly: this.options?.asrOnly ?? false })
    const endedAt = Date.now()
    this.queue.push({ audio, runId, startedAt: endedAt - frames.length * FRAME_MS, endedAt })
    this.queuedBytes += audio.byteLength
    setQueueDepth(this.queue.length)
    this.processNext()
  }

  private processNext() {
    if (this.activeJob || !this.provider || !this.startOptions || !['starting', 'listening'].includes(this.snapshot.state)) return
    const job = this.queue.shift()
    if (!job) return
    this.queuedBytes -= job.audio.byteLength
    this.activeRunId = job.runId
    this.publishedAsrJob = 0
    markQueued(job.runId)
    setQueueDepth(this.queue.length)
    const generation = this.generation
    this.activeJob = ++sequence
    this.processingTimer = setTimeout(() => {
      if (generation === this.generation && this.activeJob) {
        if (this.activeRunId !== null) {
          failRun(this.activeRunId, 'timeout', t('systemAudio.timeout'))
          this.activeRunId = null
        }
        this.fail(t('systemAudio.timeout'))
      }
    }, PROCESSING_TIMEOUT_MS)
    try {
      if (!this.provider.start({ ...this.startOptions, runId: this.activeJob })) throw new Error('ASR did not start')
      setPipelineActivity({ phase: 'asr', stageStartedAt: Date.now() })
      this.provider.sendAudio(job.audio.buffer as ArrayBuffer)
      if (!this.provider.stop()) throw new Error('ASR did not accept the segment')
    } catch (error) { this.fail(t('systemAudio.notReady'), String(error)) }
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
    this.publish({ state: 'error', caption: '', error: message, warning: '' })
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
    this.publish({ state: 'paused', caption: '', warning: '' })
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
    this.publish({ state: 'stopping', caption: '', error: '', warning: '' })
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
      this.publish({ state: 'idle', caption: '', error: '', warning: '' })
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

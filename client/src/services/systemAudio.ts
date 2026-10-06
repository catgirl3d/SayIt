import * as bridge from './bridge'
import { t } from '@/i18n'
import { getPromptPresets, getSetting, TRANSLATION_PRESET_PREFIX } from './store'
import { normalizeSpeechInputLanguage, type SpeechInputLanguage } from './speechInputLanguage'
import { addRuntimeEvent } from './debugLog'
import { describeProviderError } from '@/lib/errorMessages'
import type { StartOptions, TranscriptionProvider } from './transcription/types'
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

// Must match FRAME_SAMPLES = 512 i16 little-endian samples emitted by client/src-tauri/src/commands/system_audio.rs; receiveFrame hard-fails if the byte length differs.
const FRAME_BYTES = 512 * 2
const PRE_ROLL_FRAMES = 8
const MIN_VOICED_FRAMES = 8
const END_SILENCE_FRAMES = 15
const MAX_SEGMENT_FRAMES = 188
const MAX_PENDING_BYTES = 16_000 * 2 * 12
// Close the current speech segment after this receive inactivity interval.
const FRAME_RECEIVE_GAP_MS = 512
const PROCESSING_TIMEOUT_MS = 30_000
const CAPTION_HOLD_MS = 8_000
let sequence = Date.now()

export async function getSystemAudioSourceLanguage(): Promise<SpeechInputLanguage> {
  return normalizeSpeechInputLanguage(await getSetting('systemAudio.sourceLanguage', 'auto'))
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
  private options: { deviceId: string; targetLanguage: SubtitleTargetLanguage } | null = null
  private startOptions: Omit<StartOptions, 'runId'> | null = null
  private starting: Promise<void> | null = null
  private stopping: Promise<void> | null = null
  private captureId = 0
  private captureStop: Promise<void> = Promise.resolve()
  private unlisteners: Array<() => void> = []
  private overlayUpdates: Promise<void> = Promise.resolve()
  private frames: Uint8Array[] = []
  private preRoll: Uint8Array[] = []
  private voicedFrames = 0
  private silenceFrames = 0
  private continuation = false
  private queue: Uint8Array[] = []
  private queuedBytes = 0
  private activeJob = 0
  private lastFrameAt = 0
  private gapTimer: ReturnType<typeof setTimeout> | null = null
  private processingTimer: ReturnType<typeof setTimeout> | null = null
  private captionTimer: ReturnType<typeof setTimeout> | null = null

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(change: Partial<SystemAudioSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change }
    this.listeners.forEach((listener) => listener())
    if (!this.leased) return
    const generation = this.generation
    const payload = this.overlayPayload()
    this.overlayUpdates = this.overlayUpdates.then(async () => {
      if (generation === this.generation && this.leased) await this.dependencies.overlay.update(payload)
    })
  }

  private overlayPayload(): SubtitleOverlayPayload {
    return {
      subtitleText: this.snapshot.caption,
      subtitleStatus: this.snapshot.warning || t(`systemAudio.status.${this.snapshot.state}`),
      subtitleError: this.snapshot.error,
    }
  }

  async start(options: { deviceId: string; targetLanguage: SubtitleTargetLanguage }): Promise<void> {
    if (this.snapshot.state !== 'idle') return
    this.options = { ...options }
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
      const [presets, language, hotwords] = await Promise.all([
        getPromptPresets(), getSystemAudioSourceLanguage(), loadActiveHotwords(),
      ])
      if (generation !== this.generation) return
      const prompt = presets.find((preset) => preset.id === `${TRANSLATION_PRESET_PREFIX}${this.options!.targetLanguage}`)?.systemPrompt
      if (!prompt?.trim()) throw new Error(t('systemAudio.notReady'))
      this.startOptions = { systemPrompt: prompt, language, hotwords, disableAi: false, aiMinDurationSec: 0, requireTranslation: true }
      this.provider = this.dependencies.getProvider()
      await this.provider.connect({
        onReady: (ready) => {
          if (generation !== this.generation) return
          if (!ready.asr || (this.provider?.mode === 'server' && !ready.llm)) this.fail(t('systemAudio.notReady'))
        },
        onFinal: (result) => {
          if (generation !== this.generation || !this.activeJob) return
          if (!result.asrText.trim()) return
          // The managed server LLM falls back to the input text when its answer is empty or
          // think-only while still reporting elapsed time, so an "applied" result can be the
          // original speech. A translation identical to the transcript is never shown as one.
          const comparableTranslation = result.llmText.replace(/\s+/g, ' ').trim()
          const comparableSource = result.asrText.replace(/\s+/g, ' ').trim()
          if (result.aiStatus !== 'applied' || !comparableTranslation || comparableTranslation === comparableSource) {
            this.fail(t('systemAudio.translationFailed'))
            return
          }
          if (this.captionTimer) clearTimeout(this.captionTimer)
          this.publish({ caption: result.llmText.trim(), warning: '' })
          this.captionTimer = setTimeout(() => {
            if (generation === this.generation) this.publish({ caption: '' })
          }, CAPTION_HOLD_MS)
        },
        onDone: () => {
          if (generation !== this.generation || !this.activeJob) return
          this.activeJob = 0
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
      this.resetSegment()
      this.publish({ caption: '', warning: t('systemAudio.discontinuity') })
      addRuntimeEvent('warn', 'system-audio', 'Audio gap; unfinished speech discarded, listening continues')
    }

    const now = Date.now()
    if (this.lastFrameAt && now - this.lastFrameAt >= FRAME_RECEIVE_GAP_MS) this.closeGap()
    if (this.snapshot.state === 'error') return
    this.lastFrameAt = now
    if (this.gapTimer) clearTimeout(this.gapTimer)
    const generation = this.generation
    this.gapTimer = setTimeout(() => { if (generation === this.generation) this.closeGap() }, FRAME_RECEIVE_GAP_MS)

    const voiced = frame.speechProbability >= 0.3
    if (!this.frames.length && !this.continuation && !voiced) {
      this.preRoll.push(audio)
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
      return
    }
    if (!this.frames.length) {
      this.frames = this.preRoll
      this.preRoll = []
    }
    this.frames.push(audio)
    if (voiced) { this.voicedFrames++; this.silenceFrames = 0 } else { this.silenceFrames++ }
    if (this.silenceFrames >= END_SILENCE_FRAMES) this.finishSegment(false)
    else if (this.frames.length >= MAX_SEGMENT_FRAMES) this.finishSegment(true)
  }

  private closeGap() {
    if (this.gapTimer) clearTimeout(this.gapTimer)
    this.gapTimer = null
    this.finishSegment(false)
    this.preRoll = []
    this.lastFrameAt = 0
  }

  private finishSegment(hardSplit: boolean) {
    const eligible = this.voicedFrames >= MIN_VOICED_FRAMES || (this.continuation && this.voicedFrames > 0)
    const frames = this.frames
    this.frames = []
    this.voicedFrames = 0
    this.silenceFrames = 0
    this.continuation = hardSplit && eligible
    if (!eligible || !frames.length) return
    // A short continuation still contains real speech; pad only the submitted job to the ASR minimum.
    const audio = new Uint8Array(Math.max(10, frames.length) * FRAME_BYTES)
    frames.forEach((frame, index) => audio.set(frame, index * FRAME_BYTES))
    if (this.queuedBytes + audio.byteLength > MAX_PENDING_BYTES) { this.fail(t('systemAudio.overload')); return }
    this.queue.push(audio)
    this.queuedBytes += audio.byteLength
    this.processNext()
  }

  private processNext() {
    if (this.activeJob || !this.provider || !this.startOptions || !['starting', 'listening'].includes(this.snapshot.state)) return
    const audio = this.queue.shift()
    if (!audio) return
    this.queuedBytes -= audio.byteLength
    const generation = this.generation
    this.activeJob = ++sequence
    this.processingTimer = setTimeout(() => {
      if (generation === this.generation && this.activeJob) this.fail(t('systemAudio.timeout'))
    }, PROCESSING_TIMEOUT_MS)
    try {
      if (!this.provider.start({ ...this.startOptions, runId: this.activeJob })) throw new Error('ASR did not start')
      this.provider.sendAudio(audio.buffer as ArrayBuffer)
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
    this.queue = []
    this.queuedBytes = this.activeJob = 0
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

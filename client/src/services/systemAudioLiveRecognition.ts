import { FRAME_BYTES, FRAME_MS } from './subtitleSegmentation'
import type { SegmentCloseReason } from './pipelineTrace'
import type { LiveAsrResult } from './transcription/types'

// Cap the displayed live phrase at 16 KiB of UTF-8 text; an oversized phrase stops live recognition.
const MAX_LIVE_PHRASE_BYTES = 16 * 1024
// Retain at most 64 live audio-to-capture-time anchors; older anchors are discarded as the stream advances.
const MAX_LIVE_TIME_ANCHORS = 64
// Bound unmatched live finalize requests at 32; retire the oldest frontier when the bound is reached.
const MAX_LIVE_FINALIZE_REQUESTS = 32
// Require 512 ms (16 frame periods) of native capture time beyond the last audio end before accepting idle confirmation.
const LIVE_IDLE_CONFIRMATION_US = 512_000
// Allow 4 microseconds of timestamp tolerance when validating live frame duration and detecting source gaps.
// Must match CAPTURE_TIME_TOLERANCE_US in client/src-tauri/src/commands/system_audio.rs; change both together.
const LIVE_CAPTURE_TIME_TOLERANCE_US = 4

export interface LiveCaptureAnchor {
  readonly audioOffsetSamples: number
  readonly captureUnixUs: number
}

export interface LiveFrameTiming {
  readonly frameSequence: number
  readonly captureStartUnixUs: number | null
  readonly captureEndUnixUs: number | null
  readonly captureAnchors: readonly LiveCaptureAnchor[]
}

export interface LiveIdleTiming {
  readonly frameSequence: number
  readonly lastFrameCaptureEndUnixUs: number | null
  readonly lastAudioCaptureEndUnixUs: number | null
  readonly confirmedThroughUnixUs: number
}

export interface LiveSpeechAccumulatorOptions {
  readonly language: string
  readonly targetMs: number
}

export interface LiveFinalizeRequest {
  readonly afterFrontierMs: number
  readonly frontierMs: number
  readonly closeReason: SegmentCloseReason
  readonly targetStartMs: number
}

export type LiveRecognitionErrorKind =
  | 'frameTiming'
  | 'anchor'
  | 'frameSequence'
  | 'idle'
  | 'resultRange'
  | 'overflow'
  | 'timingUnavailable'

export interface LiveRecognitionError {
  readonly kind: LiveRecognitionErrorKind
  readonly detail: string
}

export type LiveFrameInspection =
  | { readonly kind: 'duplicate' }
  | {
      readonly kind: 'accepted'
      readonly timing: LiveFrameTiming
      readonly sourceGapUs: number | null
      readonly closeGap: boolean
      readonly audioStartMs: number
    }
  | { readonly kind: 'error'; readonly error: LiveRecognitionError }

export type LiveIdleOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'closeGap' }
  | { readonly kind: 'error'; readonly error: LiveRecognitionError }

export interface LiveFrameSendResult {
  readonly targetCrossed: boolean
  readonly targetStartMs: number
  readonly pendingText: boolean
  readonly confirmedBoundaryMs: number | null
}

export interface LiveGapCloseAction {
  readonly confirmedBoundaryMs: number | null
  readonly shouldFinalize: boolean
}

export type LiveResultOutcome =
  | { readonly kind: 'ignored' }
  | { readonly kind: 'updated'; readonly liveOriginal: string }
  | {
      readonly kind: 'commit'
      readonly boundaryAudioMs: number
      readonly closeReason: SegmentCloseReason
      readonly targetStartMs: number
      readonly matchedFinalizeRequest: LiveFinalizeRequest | null
    }
  | { readonly kind: 'error'; readonly error: LiveRecognitionError }

export interface LiveCommitReady {
  readonly boundaryAudioMs: number
  readonly targetStartMs: number
  readonly text: string
  readonly startedAt: number | null
  readonly endedAt: number | null
  readonly confirmedAt: number | null
  readonly asrEngine: string
  readonly asrModel: string
}

export type LiveCommitPreparation =
  | { readonly kind: 'none' }
  | ({ readonly kind: 'ready' } & LiveCommitReady)
  | { readonly kind: 'error'; readonly error: LiveRecognitionError }

export interface LiveCommitCompletion {
  readonly liveOriginal: string
}

interface LiveTimeAnchor {
  audioMs: number
  capturedAt: number
}

/**
 * Synchronously owns live ASR text, native source timing, phrase boundaries, and finalize bookkeeping.
 * Provider lifecycle, presentation, tracing, translation, and session epochs remain outside this class.
 */
export class LiveSpeechAccumulator {
  private readonly language: string
  private readonly targetMs: number
  private lastResultId = 0
  private audioFrontierMs = 0
  private timeAnchors: LiveTimeAnchor[] = []
  private lastCaptureFrameSequence = 0
  private lastCaptureFrameEndUnixUs: number | null = null
  private lastIdleFrameSequence = -1
  private lastIdleAudioEndUnixUs = -1
  private stableWatermark = 0
  private committedWatermark = 0
  private confirmedText = ''
  private confirmedStartMs: number | null = null
  private confirmedEndMs = 0
  private confirmedAt: number | null = null
  private interimText = ''
  private interimStartMs: number | null = null
  private interimEndMs = 0
  private phraseStartMs: number | null = null
  private phraseEngine = ''
  private phraseModel = ''
  private targetStartMs = 0
  private finalizedFrontierMs = -1
  private finalizeRequests: LiveFinalizeRequest[] = []
  private lastFinalizeRequest: LiveFinalizeRequest | null = null
  private finalizeRetiredThroughMs = -1

  constructor(options: LiveSpeechAccumulatorOptions) {
    this.language = options.language
    this.targetMs = options.targetMs
  }

  get audioMs(): number {
    return this.audioFrontierMs
  }

  get liveOriginal(): string {
    return this.joinText(this.confirmedText, this.interimText)
  }

  reset(): void {
    this.lastResultId = 0
    this.audioFrontierMs = 0
    this.timeAnchors = []
    this.lastCaptureFrameSequence = 0
    this.lastCaptureFrameEndUnixUs = null
    this.lastIdleFrameSequence = -1
    this.lastIdleAudioEndUnixUs = -1
    this.stableWatermark = 0
    this.committedWatermark = 0
    this.confirmedText = ''
    this.confirmedStartMs = null
    this.confirmedEndMs = 0
    this.confirmedAt = null
    this.interimText = ''
    this.interimStartMs = null
    this.interimEndMs = 0
    this.phraseStartMs = null
    this.phraseEngine = ''
    this.phraseModel = ''
    this.targetStartMs = 0
    this.finalizedFrontierMs = -1
    this.finalizeRequests = []
    this.lastFinalizeRequest = null
    this.finalizeRetiredThroughMs = -1
  }

  inspectFrame(frame: LiveFrameTiming): LiveFrameInspection {
    // Native owns the timing policy and already absorbs the audio engine's sub-millisecond
    // clock slew, so the boundary verifies only that the payload is structurally sound:
    // never re-derive microsecond arithmetic that would let normal jitter abort the session.
    if (!Number.isSafeInteger(frame.frameSequence) || frame.frameSequence < 1
      || !Number.isSafeInteger(frame.captureStartUnixUs) || !Number.isSafeInteger(frame.captureEndUnixUs)
      || frame.captureStartUnixUs === null || frame.captureEndUnixUs === null
      || frame.captureEndUnixUs - frame.captureStartUnixUs < FRAME_MS * 1_000 - LIVE_CAPTURE_TIME_TOLERANCE_US
      || !Array.isArray(frame.captureAnchors) || frame.captureAnchors.length > MAX_LIVE_TIME_ANCHORS) {
      return { kind: 'error', error: { kind: 'frameTiming', detail: 'Missing or malformed native source capture timing' } }
    }

    let previousAnchorOffset = 0
    let previousAnchorTime = frame.captureStartUnixUs
    for (const anchor of frame.captureAnchors) {
      if (!Number.isSafeInteger(anchor.audioOffsetSamples) || anchor.audioOffsetSamples <= previousAnchorOffset
        || anchor.audioOffsetSamples >= FRAME_BYTES / 2
        || !Number.isSafeInteger(anchor.captureUnixUs)
        || anchor.captureUnixUs <= previousAnchorTime || anchor.captureUnixUs >= frame.captureEndUnixUs) {
        return { kind: 'error', error: { kind: 'anchor', detail: 'Malformed native intra-frame source timing anchor' } }
      }
      previousAnchorOffset = anchor.audioOffsetSamples
      previousAnchorTime = anchor.captureUnixUs
    }

    if (frame.frameSequence <= this.lastCaptureFrameSequence) return { kind: 'duplicate' }
    if (frame.frameSequence !== this.lastCaptureFrameSequence + 1) {
      return { kind: 'error', error: { kind: 'frameSequence', detail: 'Native source frame sequence has a gap' } }
    }

    const sourceGapUs = this.lastCaptureFrameEndUnixUs === null
      ? null
      : frame.captureStartUnixUs - this.lastCaptureFrameEndUnixUs
    return {
      kind: 'accepted',
      timing: frame,
      sourceGapUs,
      closeGap: sourceGapUs !== null && sourceGapUs >= LIVE_IDLE_CONFIRMATION_US,
      audioStartMs: this.audioFrontierMs,
    }
  }

  recordFrame(frame: Extract<LiveFrameInspection, { kind: 'accepted' }>): void {
    const { timing } = frame
    const frameAudioStartMs = frame.audioStartMs
    if (this.lastCaptureFrameEndUnixUs === null) {
      this.addTimeAnchor(this.audioFrontierMs, timing.captureStartUnixUs! / 1_000)
    } else if (frame.sourceGapUs !== null && frame.sourceGapUs > LIVE_CAPTURE_TIME_TOLERANCE_US) {
      this.addTimeAnchor(this.audioFrontierMs, timing.captureStartUnixUs! / 1_000)
    }
    for (const anchor of timing.captureAnchors) {
      this.addTimeAnchor(
        frameAudioStartMs + anchor.audioOffsetSamples * FRAME_MS / (FRAME_BYTES / 2),
        anchor.captureUnixUs / 1_000,
      )
    }
    this.lastCaptureFrameSequence = timing.frameSequence
    this.lastCaptureFrameEndUnixUs = timing.captureEndUnixUs
  }

  markFrameSent(): LiveFrameSendResult {
    this.audioFrontierMs += FRAME_MS
    if (this.audioFrontierMs - this.targetStartMs < this.targetMs) {
      return {
        targetCrossed: false,
        targetStartMs: this.targetStartMs,
        pendingText: false,
        confirmedBoundaryMs: null,
      }
    }

    this.targetStartMs = this.audioFrontierMs
    const pendingText = Boolean(this.confirmedText.trim() || this.interimText.trim())
    return {
      targetCrossed: true,
      targetStartMs: this.targetStartMs,
      pendingText,
      confirmedBoundaryMs: pendingText && this.confirmedText.trim() ? this.confirmedEndMs : null,
    }
  }

  acceptIdle(idle: LiveIdleTiming): LiveIdleOutcome {
    if (!Number.isSafeInteger(idle.frameSequence) || idle.frameSequence < 0) {
      return { kind: 'error', error: { kind: 'idle', detail: 'Malformed native source idle sequence' } }
    }
    if (idle.frameSequence < this.lastCaptureFrameSequence) return { kind: 'ignored' }
    if (idle.frameSequence > this.lastCaptureFrameSequence) return { kind: 'ignored' }
    if (!Number.isSafeInteger(idle.confirmedThroughUnixUs)
      || !Number.isSafeInteger(idle.lastAudioCaptureEndUnixUs)
      || idle.lastAudioCaptureEndUnixUs === null
      || idle.confirmedThroughUnixUs < idle.lastAudioCaptureEndUnixUs + LIVE_IDLE_CONFIRMATION_US) {
      return { kind: 'error', error: { kind: 'idle', detail: 'Malformed native source idle confirmation' } }
    }
    if (idle.frameSequence === 0 && this.lastCaptureFrameEndUnixUs === null) return { kind: 'ignored' }
    if (!Number.isSafeInteger(idle.lastFrameCaptureEndUnixUs)
      || idle.lastFrameCaptureEndUnixUs === null
      || idle.lastFrameCaptureEndUnixUs !== this.lastCaptureFrameEndUnixUs
      || idle.lastAudioCaptureEndUnixUs < idle.lastFrameCaptureEndUnixUs) {
      return { kind: 'error', error: { kind: 'idle', detail: 'Native source idle confirmation does not match the frame frontier' } }
    }
    if (idle.frameSequence < this.lastIdleFrameSequence
      || (idle.frameSequence === this.lastIdleFrameSequence
        && idle.lastAudioCaptureEndUnixUs <= this.lastIdleAudioEndUnixUs)) return { kind: 'ignored' }
    this.lastIdleFrameSequence = idle.frameSequence
    this.lastIdleAudioEndUnixUs = idle.lastAudioCaptureEndUnixUs
    return { kind: 'closeGap' }
  }

  acceptResult(result: LiveAsrResult, receivedAt: number): LiveResultOutcome {
    if (result.resultId <= this.lastResultId) return { kind: 'ignored' }
    if (!Number.isFinite(result.audioStartMs) || !Number.isFinite(result.audioEndMs)
      || result.audioStartMs < 0 || result.audioEndMs < result.audioStartMs || typeof result.text !== 'string') {
      return { kind: 'error', error: { kind: 'resultRange', detail: 'Invalid live recognition range' } }
    }

    this.lastResultId = result.resultId
    const matchedFinalizeRequest = result.fromFinalize ? this.findFinalizeRequest(result.audioEndMs) : null
    if (result.audioEndMs <= this.committedWatermark || result.audioStartMs < this.committedWatermark) return { kind: 'ignored' }

    let changed = false
    const text = result.text.trim()
    if (result.isFinal) {
      if (result.audioStartMs >= this.stableWatermark && result.audioEndMs > this.stableWatermark) {
        this.stableWatermark = result.audioEndMs
        if (text) {
          if (this.phraseStartMs === null) {
            this.phraseStartMs = result.audioStartMs
            this.phraseEngine = result.asrEngine
            this.phraseModel = result.asrModel
          }
          this.confirmedStartMs ??= result.audioStartMs
          this.confirmedText = this.joinText(this.confirmedText, text)
          this.confirmedEndMs = result.audioEndMs
          this.confirmedAt = receivedAt
        }
        if (this.interimStartMs !== null && this.interimStartMs < this.stableWatermark) {
          this.interimText = ''
          this.interimStartMs = null
          this.interimEndMs = 0
        }
        changed = true
      }
    } else if (result.audioStartMs >= this.stableWatermark && result.audioEndMs > this.stableWatermark) {
      this.interimText = text
      this.interimStartMs = result.audioStartMs
      this.interimEndMs = result.audioEndMs
      if (this.phraseStartMs === null) {
        this.phraseStartMs = result.audioStartMs
        this.phraseEngine = result.asrEngine
        this.phraseModel = result.asrModel
      }
      changed = true
    }

    if (new TextEncoder().encode(this.liveOriginal).byteLength > MAX_LIVE_PHRASE_BYTES) {
      return { kind: 'error', error: { kind: 'overflow', detail: 'Live phrase exceeds the UTF-8 display limit' } }
    }

    const finalizeRequest = matchedFinalizeRequest ?? (result.fromFinalize ? this.lastFinalizeRequest : null)
    const fromFinalizeWithMetadata = result.fromFinalize && finalizeRequest !== null
    if ((result.speechFinal || fromFinalizeWithMetadata)
      && result.audioEndMs > this.committedWatermark
      && result.audioEndMs >= this.stableWatermark
      && (this.phraseStartMs === null || result.audioEndMs > this.phraseStartMs)) {
      return {
        kind: 'commit',
        boundaryAudioMs: result.audioEndMs,
        closeReason: finalizeRequest?.closeReason ?? (result.fromFinalize ? 'gap' : 'silence'),
        targetStartMs: finalizeRequest?.closeReason === 'cap'
          ? finalizeRequest.targetStartMs
          : result.speechFinal ? result.audioEndMs : this.audioFrontierMs,
        matchedFinalizeRequest,
      }
    }
    return changed ? { kind: 'updated', liveOriginal: this.liveOriginal } : { kind: 'ignored' }
  }

  prepareGapClose(): LiveGapCloseAction {
    return {
      confirmedBoundaryMs: this.confirmedText ? this.confirmedEndMs : null,
      shouldFinalize: this.audioFrontierMs > this.finalizedFrontierMs,
    }
  }

  registerFinalize(closeReason: SegmentCloseReason): LiveFinalizeRequest | null {
    const frontierMs = this.audioFrontierMs
    if (frontierMs <= this.finalizedFrontierMs) return null
    const request: LiveFinalizeRequest = {
      afterFrontierMs: this.finalizedFrontierMs,
      frontierMs,
      closeReason,
      targetStartMs: this.targetStartMs,
    }
    if (this.finalizeRequests.length >= MAX_LIVE_FINALIZE_REQUESTS) {
      const retired = this.finalizeRequests.shift()!
      this.finalizeRetiredThroughMs = Math.max(this.finalizeRetiredThroughMs, retired.frontierMs)
    }
    this.finalizeRequests.push(request)
    this.lastFinalizeRequest = request
    this.finalizedFrontierMs = frontierMs
    return request
  }

  consumeFinalizeRequest(request: LiveFinalizeRequest): void {
    const index = this.finalizeRequests.indexOf(request)
    if (index < 0) return
    this.finalizeRequests.splice(0, index + 1)
    this.finalizeRetiredThroughMs = Math.max(this.finalizeRetiredThroughMs, request.frontierMs)
  }

  prepareCommit(boundaryAudioMs: number, targetStartMs = this.audioFrontierMs): LiveCommitPreparation {
    if (boundaryAudioMs <= this.committedWatermark) return { kind: 'none' }
    const text = this.confirmedText.trim()
    const startAudioMs = this.confirmedStartMs
    const endAudioMs = text && this.confirmedEndMs > 0 ? this.confirmedEndMs : boundaryAudioMs
    if (text && startAudioMs !== null) {
      const startedAt = this.mapAudioTime(startAudioMs, 'start')
      const endedAt = this.mapAudioTime(endAudioMs, 'end')
      if (startedAt === null || endedAt === null) {
        return { kind: 'error', error: { kind: 'timingUnavailable', detail: 'Live source capture timing is no longer retained' } }
      }
      return {
        kind: 'ready',
        boundaryAudioMs,
        targetStartMs,
        text,
        startedAt,
        endedAt: Math.max(startedAt, endedAt),
        confirmedAt: this.confirmedAt,
        asrEngine: this.phraseEngine,
        asrModel: this.phraseModel,
      }
    }
    return {
      kind: 'ready',
      boundaryAudioMs,
      targetStartMs,
      text,
      startedAt: null,
      endedAt: null,
      confirmedAt: null,
      asrEngine: this.phraseEngine,
      asrModel: this.phraseModel,
    }
  }

  completeCommit(commit: LiveCommitReady): LiveCommitCompletion {
    this.committedWatermark = Math.max(this.committedWatermark, commit.boundaryAudioMs)
    this.confirmedText = ''
    this.confirmedStartMs = null
    this.confirmedEndMs = 0
    this.confirmedAt = null
    if (this.interimStartMs === null || this.interimEndMs <= commit.boundaryAudioMs) {
      this.interimText = ''
      this.interimStartMs = null
      this.interimEndMs = 0
    }
    this.phraseStartMs = this.interimStartMs
    if (this.phraseStartMs === null) {
      this.phraseEngine = ''
      this.phraseModel = ''
    }
    this.targetStartMs = commit.targetStartMs
    return { liveOriginal: this.liveOriginal }
  }

  private addTimeAnchor(audioMs: number, capturedAt: number): void {
    const last = this.timeAnchors[this.timeAnchors.length - 1]
    if (last?.audioMs === audioMs) {
      last.capturedAt = capturedAt
      return
    }
    this.timeAnchors.push({ audioMs, capturedAt })
    if (this.timeAnchors.length > MAX_LIVE_TIME_ANCHORS) this.timeAnchors.shift()
  }

  private mapAudioTime(audioMs: number, edge: 'start' | 'end'): number | null {
    for (let index = this.timeAnchors.length - 1; index >= 0; index--) {
      const anchor = this.timeAnchors[index]!
      const applies = edge === 'start' ? anchor.audioMs <= audioMs : anchor.audioMs < audioMs || index === 0
      if (applies) return anchor.capturedAt + audioMs - anchor.audioMs
    }
    return null
  }

  private findFinalizeRequest(audioEndMs: number): LiveFinalizeRequest | null {
    // Results have no request ID; match only their audio window and never shift a later result into an expired one.
    if (audioEndMs <= this.finalizeRetiredThroughMs) return null
    return this.finalizeRequests.find((request) =>
      audioEndMs > request.afterFrontierMs && audioEndMs <= request.frontierMs,
    ) ?? null
  }

  private joinText(left: string, right: string): string {
    const first = left.trim()
    const next = right.trim()
    if (!first) return next
    if (!next) return first
    return `${first}${this.language === 'zh' ? '' : ' '}${next}`
  }
}

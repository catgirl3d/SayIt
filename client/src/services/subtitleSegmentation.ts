import type { SegmentCloseReason } from './pipelineTrace'

/** Duration of one captured frame: 512 samples at 16 kHz. */
export const FRAME_MS = 32
// Must match FRAME_SAMPLES = 512 i16 little-endian samples emitted by client/src-tauri/src/commands/system_audio.rs; receiveFrame hard-fails if the byte length differs.
export const FRAME_BYTES = 512 * 2

// The maximum segment length is user-adjustable within this range. The upper bound is the original 6 s cap:
// live translation must not wait longer than it did before the setting existed.
export const MIN_SEGMENT_SECONDS = 3
export const MAX_SEGMENT_SECONDS = 6
export const SEGMENT_SECONDS_STEP = 0.5
export const DEFAULT_SEGMENT_SECONDS = MAX_SEGMENT_SECONDS

// Pause splitting starts once a segment holds this share of its maximum length.
const SOFT_SHARE = 2 / 3

/** Clamps a stored maximum segment length to the supported range and snaps it to the slider grid. */
export function normalizeSegmentSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_SEGMENT_SECONDS
  const clamped = Math.min(MAX_SEGMENT_SECONDS, Math.max(MIN_SEGMENT_SECONDS, value))
  return Math.round(clamped / SEGMENT_SECONDS_STEP) * SEGMENT_SECONDS_STEP
}

/**
 * Frame budgets for one subtitle segment.
 * Once a segment holds `softFrames`, the first short pause closes it. A segment that never pauses is
 * force-cut at `hardFrames`, at the quietest point of the tail window rather than on the cap itself.
 */
export interface SegmentPlan {
  readonly softFrames: number
  readonly hardFrames: number
}

export function segmentPlan(maxSeconds: number): SegmentPlan {
  const hardFrames = Math.round(maxSeconds * 1000 / FRAME_MS)
  return { softFrames: Math.round(hardFrames * SOFT_SHARE), hardFrames }
}

// Scores closer than this are treated as equal so floating-point noise cannot decide which frame wins.
const SCORE_EPSILON = 1e-6

/**
 * Returns how many leading frames to keep when a segment has to be cut at its hard cap.
 * Every frame from `softFrames` onward is a candidate. A candidate is scored by the mean speech
 * probability of itself and its two neighbours (about 96 ms), so a broad pause beats a one-frame
 * dip of the voice detector. Ties go to the latest frame, which keeps segments as long as possible:
 * uniformly voiced audio is therefore cut exactly at the cap, as before.
 */
export function chooseForcedSplit(probabilities: readonly number[], softFrames: number): number {
  const last = probabilities.length - 1
  if (last < softFrames) return probabilities.length
  const score = (index: number) => {
    const from = Math.max(0, index - 1)
    const to = Math.min(last, index + 1)
    let sum = 0
    for (let i = from; i <= to; i++) sum += probabilities[i]
    return sum / (to - from + 1)
  }
  let best = last
  let bestScore = score(last)
  for (let index = last - 1; index >= softFrames; index--) {
    const candidate = score(index)
    if (candidate < bestScore - SCORE_EPSILON) {
      best = index
      bestScore = candidate
    }
  }
  return best + 1
}

/** PCM and speech score for one validated native audio frame. */
export interface SubtitleFrame {
  readonly audio: Uint8Array
  readonly probability: number
}

/** A batch segment sealed by a speech boundary. */
export interface SealedSubtitleSegment {
  readonly audio: Uint8Array
  readonly speechMs: number
  readonly closeReason: SegmentCloseReason
}

/** Per-frame state needed by the session before it submits a sealed segment. */
export interface SubtitleSegmenterPushResult {
  readonly segmentMs: number
  readonly sealed: SealedSubtitleSegment | null
}

// Retain up to 8 non-voiced frames (256 ms) before speech starts, preserving audio before voice detection turns voiced.
const PRE_ROLL_FRAMES = 8
// Require 8 voiced frames (256 ms) before submitting a segment; a continuation may submit with any voiced frame.
const MIN_VOICED_FRAMES = 8
// End an open segment after 15 silent frames (480 ms).
const END_SILENCE_FRAMES = 15
// A pause this long (160 ms) is a phrase boundary, not a gap between words or a stop consonant.
// Once a segment has reached its soft length (see segmentPlan) the first such pause closes it early,
// so continuous speech is cut between phrases instead of waiting for the hard cap.
const PAUSE_SPLIT_FRAMES = 5
// Silero speech probability at or above which a frame counts as voiced.
const SPEECH_THRESHOLD = 0.3

const isVoiced = (frame: SubtitleFrame) => frame.probability >= SPEECH_THRESHOLD

/**
 * Synchronously composes captured frames into sealed batch PCM segments.
 * Receipt timing, lifecycle, tracing, and submission remain owned by the session.
 */
export class SubtitleSegmenter {
  private frames: SubtitleFrame[] = []
  private preRoll: SubtitleFrame[] = []
  private voicedFrames = 0
  private silenceFrames = 0
  private continuation = false

  constructor(private readonly plan: SegmentPlan) {}

  isSpeechOpen(): boolean {
    return this.frames.length > 0 || this.continuation
  }

  push(frame: SubtitleFrame): SubtitleSegmenterPushResult {
    const voiced = isVoiced(frame)
    if (!this.frames.length && !this.continuation && !voiced) {
      this.preRoll.push(frame)
      if (this.preRoll.length > PRE_ROLL_FRAMES) this.preRoll.shift()
      return { segmentMs: 0, sealed: null }
    }
    if (!this.frames.length) {
      this.frames = this.preRoll
      this.preRoll = []
    }
    this.frames.push(frame)
    const segmentMs = this.frames.length * FRAME_MS
    if (voiced) {
      this.voicedFrames++
      this.silenceFrames = 0
    } else {
      this.silenceFrames++
    }

    let sealed: SealedSubtitleSegment | null = null
    if (this.silenceFrames >= END_SILENCE_FRAMES) sealed = this.finishSegment('silence')
    else if (this.frames.length >= this.plan.softFrames && this.silenceFrames >= PAUSE_SPLIT_FRAMES) sealed = this.finishSegment('pause')
    else if (this.frames.length >= this.plan.hardFrames) sealed = this.splitAtQuietestPoint()
    return { segmentMs, sealed }
  }

  closeGap(): SealedSubtitleSegment | null {
    const last = this.frames[this.frames.length - 1]
    const sealed = this.finishSegment(last && isVoiced(last) ? 'dropout' : 'gap')
    this.preRoll = []
    return sealed
  }

  reset(): void {
    this.frames = []
    this.preRoll = []
    this.voicedFrames = 0
    this.silenceFrames = 0
    this.continuation = false
  }

  // The segment hit its hard cap without a phrase boundary. Cut at the quietest point of the tail window and
  // carry the frames after it into the next segment, so a word is not severed on an arbitrary frame.
  private splitAtQuietestPoint(): SealedSubtitleSegment | null {
    const keep = chooseForcedSplit(this.frames.map((frame) => frame.probability), this.plan.softFrames)
    return this.finishSegment('cap', this.frames.splice(keep))
  }

  // `carry` holds frames that were captured after the cut point and open the next segment. A pause or length-limit
  // cut means speech is still going on, so the next segment continues it; every other reason ends the utterance.
  private finishSegment(reason: SegmentCloseReason, carry: SubtitleFrame[] = []): SealedSubtitleSegment | null {
    const eligible = this.voicedFrames >= MIN_VOICED_FRAMES || (this.continuation && this.voicedFrames > 0)
    const frames = this.frames
    this.frames = carry
    this.voicedFrames = carry.filter(isVoiced).length
    this.silenceFrames = 0
    while (this.silenceFrames < carry.length && !isVoiced(carry[carry.length - 1 - this.silenceFrames]!)) this.silenceFrames++
    this.continuation = (reason === 'pause' || reason === 'cap') && eligible
    if (!eligible || !frames.length) return null

    // A short continuation still contains real speech; pad only the submitted job to the ASR minimum.
    const audio = new Uint8Array(Math.max(10, frames.length) * FRAME_BYTES)
    frames.forEach((frame, index) => audio.set(frame.audio, index * FRAME_BYTES))
    return { audio, speechMs: frames.length * FRAME_MS, closeReason: reason }
  }
}

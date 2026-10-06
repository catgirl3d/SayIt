/** Duration of one captured frame: 512 samples at 16 kHz. */
export const FRAME_MS = 32

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

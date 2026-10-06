import { describe, expect, it } from 'vitest'
import {
  chooseForcedSplit,
  DEFAULT_SEGMENT_SECONDS,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  normalizeSegmentSeconds,
  segmentPlan,
  SEGMENT_SECONDS_STEP,
} from '../subtitleSegmentation'

describe('maximum segment length setting', () => {
  it('offers 3 to 6 seconds and defaults to the original 6 s cap, never longer', () => {
    expect(MIN_SEGMENT_SECONDS).toBe(3)
    expect(MAX_SEGMENT_SECONDS).toBe(6)
    expect(DEFAULT_SEGMENT_SECONDS).toBe(6)
  })

  it('keeps values that are already on the slider grid', () => {
    expect(normalizeSegmentSeconds(3)).toBe(3)
    expect(normalizeSegmentSeconds(4.5)).toBe(4.5)
    expect(normalizeSegmentSeconds(6)).toBe(6)
  })

  it('clamps out-of-range values and snaps the rest to the grid', () => {
    expect(normalizeSegmentSeconds(1)).toBe(3)
    expect(normalizeSegmentSeconds(12)).toBe(6)
    expect(normalizeSegmentSeconds(4.3)).toBe(4.5)
    expect(normalizeSegmentSeconds(4.2)).toBe(4)
  })

  it('falls back to the default for anything that is not a finite number', () => {
    for (const value of [undefined, null, '4', 'short', Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(normalizeSegmentSeconds(value)).toBe(DEFAULT_SEGMENT_SECONDS)
    }
  })
})

describe('segment plan', () => {
  it('converts the cap to 32 ms frames and starts pause splitting at two thirds of it', () => {
    expect(segmentPlan(6)).toEqual({ softFrames: 125, hardFrames: 188 })
    expect(segmentPlan(4.5)).toEqual({ softFrames: 94, hardFrames: 141 })
    expect(segmentPlan(3)).toEqual({ softFrames: 63, hardFrames: 94 })
  })

  it('leaves room for a pause between the soft and hard limits at every slider position', () => {
    for (let seconds = MIN_SEGMENT_SECONDS; seconds <= MAX_SEGMENT_SECONDS; seconds += SEGMENT_SECONDS_STEP) {
      const plan = segmentPlan(seconds)
      expect(plan.hardFrames - plan.softFrames).toBeGreaterThanOrEqual(30)
    }
  })
})

describe('forced split point', () => {
  const flat = (count: number, probability: number) => Array<number>(count).fill(probability)

  it('keeps the whole window when the speech is uniform, matching the old cut at the cap', () => {
    expect(chooseForcedSplit(flat(188, 0.9), 125)).toBe(188)
  })

  it('cuts inside the deepest valley of the tail window instead of at the cap', () => {
    const probabilities = flat(188, 0.9)
    probabilities[150] = 0.05
    probabilities[151] = 0.05
    expect(chooseForcedSplit(probabilities, 125)).toBe(152)
  })

  it('prefers a broad valley over a single-frame glitch', () => {
    const probabilities = flat(188, 0.9)
    probabilities[130] = 0.02
    probabilities[160] = 0.2
    probabilities[161] = 0.2
    probabilities[162] = 0.2
    expect(chooseForcedSplit(probabilities, 125)).toBe(162)
  })

  it('ignores valleys before the soft limit so chunks do not collapse into fragments', () => {
    const probabilities = flat(188, 0.9)
    probabilities[20] = 0
    probabilities[21] = 0
    expect(chooseForcedSplit(probabilities, 125)).toBe(188)
  })

  it('can cut at the first frame of the window and scores it with the frame before the window', () => {
    const probabilities = flat(188, 0.9)
    probabilities[124] = 0.1
    probabilities[125] = 0.1
    probabilities[126] = 0.1
    expect(chooseForcedSplit(probabilities, 125)).toBe(126)
  })
})

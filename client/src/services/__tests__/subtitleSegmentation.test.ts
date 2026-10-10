import { describe, expect, it } from 'vitest'
import {
  chooseForcedSplit,
  DEFAULT_SEGMENT_SECONDS,
  MAX_SEGMENT_SECONDS,
  MIN_SEGMENT_SECONDS,
  normalizeSegmentSeconds,
  segmentPlan,
  SEGMENT_SECONDS_STEP,
  SubtitleSegmenter,
} from '../subtitleSegmentation'

function pcmFrame(probability: number, value: number) {
  const audio = new Uint8Array(1024)
  new Int16Array(audio.buffer).fill(value)
  return { audio, probability }
}

function pushFrames(segmenter: SubtitleSegmenter, count: number, probability: number, value: number) {
  let sealed: ReturnType<SubtitleSegmenter['push']>['sealed'] = null
  for (let index = 0; index < count; index++) {
    sealed = segmenter.push(pcmFrame(probability, value)).sealed ?? sealed
  }
  return sealed
}

function samples(audio: Uint8Array) {
  return new Int16Array(audio.buffer, audio.byteOffset, audio.byteLength / 2)
}

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

describe('batch subtitle segmenter', () => {
  it('keeps pre-roll only after the minimum voiced count and allows a short continuation after a cap', () => {
    const segmenter = new SubtitleSegmenter({ softFrames: 63, hardFrames: 94 })

    pushFrames(segmenter, 8, 0, 11)
    pushFrames(segmenter, 7, 0.9, 22)
    expect(segmenter.closeGap()).toBeNull()

    segmenter.reset()
    pushFrames(segmenter, 8, 0, 11)
    pushFrames(segmenter, 7, 0.9, 22)
    const preRolled = segmenter.push(pcmFrame(0.9, 22))
    expect(preRolled.segmentMs).toBe(16 * 32)
    const closed = segmenter.closeGap()
    expect(closed).toMatchObject({ speechMs: 16 * 32, closeReason: 'dropout' })
    expect(closed?.audio.byteLength).toBe(16 * 1024)
    expect(samples(closed!.audio)[0]).toBe(11)
    expect(samples(closed!.audio)[8 * 512]).toBe(22)

    const continuationSegmenter = new SubtitleSegmenter({ softFrames: 7, hardFrames: 10 })
    pushFrames(continuationSegmenter, 9, 0.9, 33)
    const cap = continuationSegmenter.push(pcmFrame(0.9, 33)).sealed
    expect(cap).toMatchObject({ speechMs: 10 * 32, closeReason: 'cap' })

    const continuationFrame = continuationSegmenter.push(pcmFrame(0.9, 44))
    expect(continuationFrame.sealed).toBeNull()
    const shortContinuation = continuationSegmenter.closeGap()
    expect(shortContinuation).toMatchObject({ speechMs: 32, closeReason: 'dropout' })
    expect(shortContinuation?.audio.byteLength).toBe(10 * 1024)
    expect(samples(shortContinuation!.audio)[0]).toBe(44)
  })

  it('moves a forced cut to the quietest tail point and keeps sealed PCM stable after later input changes', () => {
    const segmenter = new SubtitleSegmenter(segmentPlan(6))

    const sealedInput = pcmFrame(0.9, 11)
    segmenter.push(sealedInput)
    pushFrames(segmenter, 149, 0.9, 11)
    pushFrames(segmenter, 2, 0.05, 22)
    pushFrames(segmenter, 35, 0.9, 33)
    const first = segmenter.push(pcmFrame(0.9, 33)).sealed
    if (!first) throw new Error('Expected the hard cap to seal the first segment')

    expect(first.speechMs).toBe(152 * 32)
    expect(first.audio.byteLength).toBe(152 * 1024)
    expect(samples(first.audio).slice(0, 150 * 512).every((sample) => sample === 11)).toBe(true)
    expect(samples(first.audio).slice(150 * 512).every((sample) => sample === 22)).toBe(true)
    expect(samples(first.audio).includes(33)).toBe(false)

    const emitted = first.audio.slice()
    sealedInput.audio.fill(99)
    pushFrames(segmenter, 24, 0.9, 33)
    const second = pushFrames(segmenter, 15, 0, 0)
    if (!second) throw new Error('Expected trailing silence to seal the carried segment')

    expect(second.audio.byteLength).toBe(75 * 1024)
    expect(samples(second.audio).slice(0, 60 * 512).every((sample) => sample === 33)).toBe(true)
    expect(samples(second.audio).slice(60 * 512).every((sample) => sample === 0)).toBe(true)
    expect(samples(second.audio).includes(99)).toBe(false)
    expect(first.audio).toEqual(emitted)
  })

  it('closes a gap, then resets unfinished state without mutating an emitted PCM buffer', () => {
    const segmenter = new SubtitleSegmenter(segmentPlan(3))

    pushFrames(segmenter, 8, 0.9, 7)
    segmenter.push(pcmFrame(0, 0))
    const closed = segmenter.closeGap()
    if (!closed) throw new Error('Expected voiced frames to seal at a gap')
    const emitted = closed.audio.slice()

    pushFrames(segmenter, 4, 0.9, 7)
    segmenter.reset()
    pushFrames(segmenter, 8, 0.9, 9)
    const afterReset = segmenter.closeGap()
    if (!afterReset) throw new Error('Expected the reset segment to seal independently')

    expect(closed.closeReason).toBe('gap')
    expect(closed.speechMs).toBe(9 * 32)
    expect(afterReset.audio.byteLength).toBe(10 * 1024)
    expect(samples(afterReset.audio)[0]).toBe(9)
    expect(samples(afterReset.audio).includes(7)).toBe(false)
    expect(closed.audio).toEqual(emitted)
  })
})

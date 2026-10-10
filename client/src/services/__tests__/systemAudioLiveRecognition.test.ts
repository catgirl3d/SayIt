import { describe, expect, it } from 'vitest'
import {
  LiveSpeechAccumulator,
  type LiveFrameTiming,
  type LiveIdleTiming,
} from '../systemAudioLiveRecognition'
import { FRAME_MS } from '../subtitleSegmentation'
import type { LiveAsrResult } from '../transcription/types'

function liveResult(overrides: Partial<LiveAsrResult> = {}): LiveAsrResult {
  return {
    sessionId: 'live-1',
    resultId: 1,
    audioStartMs: 0,
    audioEndMs: 32,
    text: '',
    isFinal: false,
    speechFinal: false,
    fromFinalize: false,
    asrEngine: 'deepgram',
    asrModel: 'nova-3',
    ...overrides,
  }
}

function frame(sequence: number, captureStartUnixUs: number, sourceGapUs = 0): LiveFrameTiming {
  const start = captureStartUnixUs + sourceGapUs
  return {
    frameSequence: sequence,
    captureStartUnixUs: start,
    captureEndUnixUs: start + 32_000,
    captureAnchors: [],
  }
}

function recordFrame(accumulator: LiveSpeechAccumulator, timing: LiveFrameTiming) {
  const inspected = accumulator.inspectFrame(timing)
  if (inspected.kind !== 'accepted') throw new Error(`Expected an accepted frame, got ${inspected.kind}`)
  if (inspected.closeGap) throw new Error('Test frame unexpectedly requires an idle gap close')
  accumulator.recordFrame(inspected)
  accumulator.markFrameSent()
}

function idle(timing: LiveFrameTiming, confirmedThroughUnixUs: number): LiveIdleTiming {
  return {
    frameSequence: timing.frameSequence,
    lastFrameCaptureEndUnixUs: timing.captureEndUnixUs,
    lastAudioCaptureEndUnixUs: timing.captureEndUnixUs,
    confirmedThroughUnixUs,
  }
}

describe('live speech accumulator', () => {
  it('appends stable words once, replaces interim text, and preserves a newer phrase across a commit', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    recordFrame(accumulator, frame(1, 1_000_000))
    recordFrame(accumulator, frame(2, 1_032_000))

    expect(accumulator.acceptResult(liveResult({ resultId: 1, audioEndMs: 32, text: 'go', isFinal: true }), 100)).toMatchObject({
      kind: 'updated',
      liveOriginal: 'go',
    })
    expect(accumulator.acceptResult(liveResult({ resultId: 2, audioStartMs: 32, audioEndMs: 64, text: 'go', isFinal: true }), 110)).toMatchObject({
      kind: 'updated',
      liveOriginal: 'go go',
    })
    expect(accumulator.acceptResult(liveResult({ resultId: 3, audioStartMs: 64, audioEndMs: 96, text: 'next' }), 120)).toMatchObject({
      kind: 'updated',
      liveOriginal: 'go go next',
    })

    const commit = accumulator.acceptResult(liveResult({ resultId: 4, audioStartMs: 64, audioEndMs: 64, speechFinal: true }), 130)
    expect(commit).toMatchObject({ kind: 'commit', boundaryAudioMs: 64, closeReason: 'silence' })
    if (commit.kind !== 'commit') throw new Error('Expected a phrase commit')

    const prepared = accumulator.prepareCommit(commit.boundaryAudioMs, commit.targetStartMs)
    expect(prepared.kind).toBe('ready')
    if (prepared.kind !== 'ready') throw new Error('Expected mapped commit metadata')
    expect(prepared.text).toBe('go go')
    expect(accumulator.completeCommit(prepared).liveOriginal).toBe('next')

    expect(accumulator.acceptResult(liveResult({
      resultId: 5,
      audioStartMs: 32,
      audioEndMs: 64,
      text: 'duplicate old phrase',
      isFinal: true,
    }), 140)).toEqual({ kind: 'ignored' })
  })

  it('rejects malformed timing without mutation and accepts only the exact native idle frontier', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    const validFirst = frame(1, 1_000_000)
    const malformed = { ...validFirst, captureEndUnixUs: validFirst.captureStartUnixUs! + 31_995 }
    const timingError = accumulator.inspectFrame(malformed)
    expect(timingError).toMatchObject({ kind: 'error', error: { kind: 'frameTiming' } })
    expect(accumulator.audioMs).toBe(0)

    const first = validFirst
    const inspected = accumulator.inspectFrame(first)
    expect(inspected).toMatchObject({ kind: 'accepted', audioStartMs: 0, closeGap: false })
    if (inspected.kind !== 'accepted') throw new Error('Expected the first frame to be accepted')
    accumulator.recordFrame(inspected)
    accumulator.markFrameSent()

    const malformedIdle = accumulator.acceptIdle(idle(first, first.captureEndUnixUs! + 511_999))
    expect(malformedIdle).toMatchObject({ kind: 'error', error: { kind: 'idle' } })
    expect(accumulator.acceptIdle(idle(first, first.captureEndUnixUs! + 512_000))).toEqual({ kind: 'closeGap' })
    expect(accumulator.acceptIdle(idle(first, first.captureEndUnixUs! + 512_000))).toEqual({ kind: 'ignored' })
  })

  it('detects a native source gap before adding the next frame anchor', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    const first = frame(1, 1_000_000)
    recordFrame(accumulator, first)

    const second = frame(2, first.captureEndUnixUs!, 512_000)
    const inspected = accumulator.inspectFrame(second)
    expect(inspected).toMatchObject({ kind: 'accepted', sourceGapUs: 512_000, closeGap: true, audioStartMs: FRAME_MS })
    expect(accumulator.audioMs).toBe(FRAME_MS)
  })

  it('matches delayed finalize results by their audio window and uses the last metadata after retirement', () => {
    const matched = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    recordFrame(matched, frame(1, 1_000_000))
    const firstRequest = matched.registerFinalize('cap')
    recordFrame(matched, frame(2, 1_032_000))
    const secondRequest = matched.registerFinalize('gap')
    if (!firstRequest || !secondRequest) throw new Error('Expected finalize metadata')

    const delayed = matched.acceptResult(liveResult({
      resultId: 1,
      audioStartMs: 32,
      audioEndMs: 64,
      text: 'delayed phrase',
      isFinal: true,
      fromFinalize: true,
    }), 100)
    expect(delayed).toMatchObject({ kind: 'commit', closeReason: 'gap', matchedFinalizeRequest: secondRequest })

    const retired = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    expect(retired.acceptResult(liveResult({ resultId: 1, audioEndMs: 32, text: 'pending' }), 100)).toMatchObject({ kind: 'updated' })
    let captureStart = 1_000_000
    for (let sequence = 1; sequence <= 33; sequence++) {
      const current = frame(sequence, captureStart)
      recordFrame(retired, current)
      retired.registerFinalize(sequence === 1 ? 'cap' : 'gap')
      captureStart = current.captureEndUnixUs!
    }

    const late = retired.acceptResult(liveResult({
      resultId: 2,
      audioStartMs: 0,
      audioEndMs: 32,
      text: 'late phrase',
      isFinal: true,
      fromFinalize: true,
    }), 200)
    expect(late).toMatchObject({ kind: 'commit', closeReason: 'gap', matchedFinalizeRequest: null })
  })

  it('keeps a mapped-commit failure non-destructive, bounds source anchors, and enforces the UTF-8 display cap', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    let captureStart = 1_000_000
    for (let sequence = 1; sequence <= 66; sequence++) {
      const current = frame(sequence, captureStart, sequence === 1 ? 0 : 5)
      recordFrame(accumulator, current)
      captureStart = current.captureEndUnixUs!
    }

    const commit = accumulator.acceptResult(liveResult({
      resultId: 1,
      audioStartMs: 0,
      audioEndMs: 32,
      text: 'Unmapped phrase',
      isFinal: true,
      speechFinal: true,
    }), 100)
    expect(commit.kind).toBe('commit')
    if (commit.kind !== 'commit') throw new Error('Expected a phrase commit')
    expect(accumulator.prepareCommit(commit.boundaryAudioMs, commit.targetStartMs)).toMatchObject({
      kind: 'error',
      error: { kind: 'timingUnavailable' },
    })
    expect(accumulator.liveOriginal).toBe('Unmapped phrase')

    accumulator.reset()
    expect(accumulator.acceptResult(liveResult({ resultId: 1, audioEndMs: 32, text: 'Fresh epoch' }), 200)).toMatchObject({
      kind: 'updated',
      liveOriginal: 'Fresh epoch',
    })

    accumulator.reset()
    expect(accumulator.acceptResult(liveResult({ resultId: 1, text: 'é'.repeat(8_193) }), 300)).toMatchObject({
      kind: 'error',
      error: { kind: 'overflow' },
    })
  })
})

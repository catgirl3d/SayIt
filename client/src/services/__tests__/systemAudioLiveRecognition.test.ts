import { describe, expect, it } from 'vitest'
import {
  LiveSpeechAccumulator,
  type LiveCommitPreparation,
  type LiveCommitReady,
  type LiveFrameSendResult,
  type LiveFrameTiming,
  type LiveIdleTiming,
  type LiveSpeechAccumulatorOptions,
} from '../systemAudioLiveRecognition'
import { FRAME_BYTES, FRAME_MS } from '../subtitleSegmentation'
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

// Retained capture anchors for a phrase that is never committed; mirrors the unexported MAX_LIVE_TIME_ANCHORS
// in systemAudioLiveRecognition.ts, so change both together.
const RETAINED_ANCHOR_LIMIT = 4_096

function recordFrame(accumulator: LiveSpeechAccumulator, timing: LiveFrameTiming, audio: Uint8Array = new Uint8Array(FRAME_BYTES)) {
  const inspected = accumulator.inspectFrame(timing)
  if (inspected.kind !== 'accepted') throw new Error(`Expected an accepted frame, got ${inspected.kind}`)
  if (inspected.closeGap) throw new Error('Test frame unexpectedly requires an idle gap close')
  accumulator.recordFrame(inspected)
  return accumulator.markFrameSent(audio)
}

/** A frame of constant-level PCM16 audio; silence by default, which always counts as a pause. */
function tone(level = 0): Uint8Array {
  return new Uint8Array(new Int16Array(FRAME_BYTES / 2).fill(level).buffer)
}

/**
 * Feeds consecutive frames and returns each frame's send result. A positive `sourceGapUs` leaves a small capture
 * gap before every frame after the first, which gives each of them its own source-time anchor: frame `k` then
 * starts at audio `32 * k` ms and capture time `1000 + 32 * k + k * sourceGapUs / 1000` ms.
 */
function createStream(accumulator: LiveSpeechAccumulator, sourceGapUs = 0) {
  let sequence = 0
  let captureStart = 1_000_000
  return (level = 0): LiveFrameSendResult => {
    sequence += 1
    const timing = frame(sequence, captureStart, sequence === 1 ? 0 : sourceGapUs)
    captureStart = timing.captureEndUnixUs!
    return recordFrame(accumulator, timing, tone(level))
  }
}

function sendFrames(send: (level?: number) => LiveFrameSendResult, count: number, level = 0): LiveFrameSendResult[] {
  return Array.from({ length: count }, () => send(level))
}

function readyCommit(prepared: LiveCommitPreparation): LiveCommitReady {
  if (prepared.kind !== 'ready') throw new Error(`Expected a ready commit, got ${prepared.kind}`)
  return prepared
}

/** Confirms `text` over the first 3200 ms (one native frame is enough for its timing) and prepares a commit of it. */
function prepareCommitOfText(
  text: string,
  options: Partial<LiveSpeechAccumulatorOptions> = {},
  atSentence = true,
): LiveCommitReady {
  const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000, ...options })
  recordFrame(accumulator, frame(1, 1_000_000))
  accumulator.acceptResult(liveResult({ resultId: 1, audioStartMs: 0, audioEndMs: 3_200, text, isFinal: true }), 100)
  return readyCommit(accumulator.prepareCommit(3_200, 3_200, atSentence))
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
    accumulator.markFrameSent(new Uint8Array(FRAME_BYTES))

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
    sendFrames(createStream(accumulator, 5), RETAINED_ANCHOR_LIMIT + 1)

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

  it('commits a phrase that spans more capture anchors than one native frame may carry', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    sendFrames(createStream(accumulator, 1_000), 66)

    const commit = accumulator.acceptResult(liveResult({
      resultId: 1,
      audioStartMs: 0,
      audioEndMs: 32,
      text: 'Mapped phrase',
      isFinal: true,
      speechFinal: true,
    }), 100)
    if (commit.kind !== 'commit') throw new Error('Expected a phrase commit')

    expect(accumulator.prepareCommit(commit.boundaryAudioMs, commit.targetStartMs)).toMatchObject({
      kind: 'ready',
      text: 'Mapped phrase',
      startedAt: 1_000,
      endedAt: 1_032,
    })
  })

  it('still maps a phrase from its first frame while the retained anchors are at their bound', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    sendFrames(createStream(accumulator, 1_000), RETAINED_ANCHOR_LIMIT)

    const commit = accumulator.acceptResult(liveResult({
      resultId: 1,
      audioStartMs: 0,
      audioEndMs: 32,
      text: 'Oldest retained phrase',
      isFinal: true,
      speechFinal: true,
    }), 100)
    if (commit.kind !== 'commit') throw new Error('Expected a phrase commit')

    expect(accumulator.prepareCommit(commit.boundaryAudioMs, commit.targetStartMs)).toMatchObject({
      kind: 'ready',
      startedAt: 1_000,
    })
  })

  it('accepts up to 64 intra-frame capture anchors in one native frame and rejects more', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    const timing = frame(1, 1_000_000)
    const anchors = (count: number) => Array.from({ length: count }, (_, index) => ({
      audioOffsetSamples: index + 1,
      captureUnixUs: timing.captureStartUnixUs! + (index + 1) * 100,
    }))

    expect(accumulator.inspectFrame({ ...timing, captureAnchors: anchors(64) })).toMatchObject({ kind: 'accepted' })
    expect(accumulator.inspectFrame({ ...timing, captureAnchors: anchors(65) })).toMatchObject({
      kind: 'error',
      error: { kind: 'frameTiming' },
    })
  })

  it('keeps the capture anchor of carried words past a cap commit so the next caption keeps exact timing', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    const send = createStream(accumulator, 1_000)
    sendFrames(send, 100)
    accumulator.acceptResult(liveResult({
      resultId: 1,
      audioStartMs: 0,
      audioEndMs: 3_200,
      text: 'Alpha beta gamma delta. Epsilon zeta eta',
      isFinal: true,
    }), 100)

    // The 16 carried characters take 16/40 of the 3200 ms of speech, so the carried words start at 1920 ms.
    const first = readyCommit(accumulator.prepareCommit(3_200, 3_200, true))
    expect(first).toMatchObject({
      text: 'Alpha beta gamma delta.',
      carryText: 'Epsilon zeta eta',
      carryAudioMs: 1_280,
      startedAt: 1_000,
      endedAt: 2_979,
    })
    accumulator.completeCommit(first)

    sendFrames(send, 10)
    accumulator.acceptResult(liveResult({
      resultId: 2,
      audioStartMs: 3_200,
      audioEndMs: 3_520,
      text: 'theta iota.',
      isFinal: true,
    }), 200)
    expect(accumulator.liveOriginal).toBe('Epsilon zeta eta theta iota.')

    // The anchor of frame 60 (1920 ms) is the one the carried start maps through; pruning back only to the
    // committed watermark (3200 ms) would leave the carried words without timing.
    expect(accumulator.prepareCommit(3_520, 3_520)).toMatchObject({
      kind: 'ready',
      text: 'Epsilon zeta eta theta iota.',
      carryText: '',
      startedAt: 2_980,
      endedAt: 4_629,
    })
  })
})

describe('caption split at a length cut', () => {
  it('ends the caption at the last sentence end when no more than 60% of the text follows it', () => {
    const text = 'First sentence ends here. Second part'
    const ready = prepareCommitOfText(text)

    expect(ready).toMatchObject({ text: 'First sentence ends here.', carryText: 'Second part' })
    expect(ready.carryText.length / text.length).toBeLessThanOrEqual(0.6)
    // 11 of the 37 characters take 11/37 of the 3200 ms of confirmed speech.
    expect(ready.carryAudioMs).toBe(951)

    expect(prepareCommitOfText('One two. Three four. Five six seven')).toMatchObject({
      text: 'One two. Three four.',
      carryText: 'Five six seven',
    })
  })

  it('prefers a sentence end over a nearer clause break that would also qualify', () => {
    const text = 'Alpha beta gamma. Delta epsilon, zeta eta'

    expect(prepareCommitOfText(text)).toMatchObject({
      text: 'Alpha beta gamma.',
      carryText: 'Delta epsilon, zeta eta',
    })
    // The clause break alone would have qualified too: 8 of the 41 characters follow it.
    expect(prepareCommitOfText(text, { sentenceCarryShare: 0.5 })).toMatchObject({
      text: 'Alpha beta gamma. Delta epsilon,',
      carryText: 'zeta eta',
    })
  })

  it('falls back to the last clause break when the sentence end leaves more than 60% of the text', () => {
    const text = 'Short. Then a long remainder follows, and ends here'
    const ready = prepareCommitOfText(text)

    expect(ready).toMatchObject({ text: 'Short. Then a long remainder follows,', carryText: 'and ends here' })
    expect('Then a long remainder follows, and ends here'.length / text.length).toBeGreaterThan(0.6)
    expect(ready.carryText.length / text.length).toBeLessThanOrEqual(1 / 3)

    expect(prepareCommitOfText('Yesterday we walked along the river for hours, then left')).toMatchObject({
      text: 'Yesterday we walked along the river for hours,',
      carryText: 'then left',
    })
  })

  it('splits nothing when the text after the clause break is more than a third of it', () => {
    const text = 'Well, this is a long remainder after the break'

    expect(prepareCommitOfText(text)).toMatchObject({ text, carryText: '', carryAudioMs: 0 })
  })

  it('moves trailing dangling words and numbers to the next caption when no punctuation qualifies', () => {
    const english = prepareCommitOfText('The results were published in the')
    expect(english).toMatchObject({ text: 'The results were published', carryText: 'in the' })

    expect(prepareCommitOfText('The new subscription plan will cost about 20')).toMatchObject({
      text: 'The new subscription plan will cost',
      carryText: 'about 20',
    })
    expect(prepareCommitOfText('The meeting will go on for another twenty five')).toMatchObject({
      text: 'The meeting will go on for another',
      carryText: 'twenty five',
    })
    expect(prepareCommitOfText('Ми довго обговорювали це питання перед')).toMatchObject({
      text: 'Ми довго обговорювали це питання',
      carryText: 'перед',
    })
    expect(prepareCommitOfText('Мы долго обсуждали вопрос и этот')).toMatchObject({
      text: 'Мы долго обсуждали вопрос',
      carryText: 'и этот',
    })
  })

  it('moves a trailing question word, with the dangling words before it, to the next caption', () => {
    expect(prepareCommitOfText('I really do not know what')).toMatchObject({ text: 'I really do not know', carryText: 'what' })
    expect(prepareCommitOfText('She never told us anything about how')).toMatchObject({
      text: 'She never told us anything',
      carryText: 'about how',
    })
    expect(prepareCommitOfText('We will find out later when')).toMatchObject({ text: 'We will find out later', carryText: 'when' })
    expect(prepareCommitOfText('Nobody could tell us where')).toMatchObject({ text: 'Nobody could tell us', carryText: 'where' })
    expect(prepareCommitOfText('They have not decided whether')).toMatchObject({ text: 'They have not decided', carryText: 'whether' })

    expect(prepareCommitOfText('Я совсем не знаю что')).toMatchObject({ text: 'Я совсем не знаю', carryText: 'что' })
    expect(prepareCommitOfText('Он так и не сказал нам как')).toMatchObject({ text: 'Он так и не сказал нам', carryText: 'как' })
    expect(prepareCommitOfText('Я ничего не знаю и как')).toMatchObject({ text: 'Я ничего не знаю', carryText: 'и как' })
    expect(prepareCommitOfText('Они долго шли под')).toMatchObject({ text: 'Они долго шли', carryText: 'под' })
    expect(prepareCommitOfText('Я совсем не знаю где')).toMatchObject({ text: 'Я совсем не знаю', carryText: 'где' })
    expect(prepareCommitOfText('Никто не мог сказать нам куда')).toMatchObject({ text: 'Никто не мог сказать нам', carryText: 'куда' })
    expect(prepareCommitOfText('Они не сказали нам откуда')).toMatchObject({ text: 'Они не сказали нам', carryText: 'откуда' })

    expect(prepareCommitOfText('Я зовсім не знаю де')).toMatchObject({ text: 'Я зовсім не знаю', carryText: 'де' })
    expect(prepareCommitOfText('Ніхто не міг сказати нам куди')).toMatchObject({ text: 'Ніхто не міг сказати нам', carryText: 'куди' })
    expect(prepareCommitOfText('Вони не сказали нам звідки')).toMatchObject({ text: 'Вони не сказали нам', carryText: 'звідки' })
  })

  it('stops the dangling-word scan at a punctuated question word and keeps the one-third limit for it', () => {
    // A comma right after the word ends the scan before it; with no space after it, it is not a clause break either.
    expect(prepareCommitOfText('Nobody could say when,')).toMatchObject({ text: 'Nobody could say when,', carryText: '' })

    // "about how" would be more than a third of the text, and a carry that is too long is dropped, not trimmed.
    expect(prepareCommitOfText('We know about how')).toMatchObject({ text: 'We know about how', carryText: '' })
    expect(prepareCommitOfText('See what')).toMatchObject({ text: 'See what', carryText: '' })
  })

  it('tries dangling words only after a clause break is out of reach and only within a third of the text', () => {
    const rejectedClause = 'Well, this remainder is about the'
    // 27 of the 33 characters follow the clause break, so it is rejected and the dangling words decide.
    expect(prepareCommitOfText(rejectedClause)).toMatchObject({ text: 'Well, this remainder is', carryText: 'about the' })

    // A clause break wins over dangling words when it qualifies.
    expect(prepareCommitOfText('We agreed on the plan, and the')).toMatchObject({
      text: 'We agreed on the plan,',
      carryText: 'and the',
    })

    // "to the" would be two thirds of the text.
    expect(prepareCommitOfText('Go to the')).toMatchObject({ text: 'Go to the', carryText: '' })
    expect(prepareCommitOfText('The results were published')).toMatchObject({ text: 'The results were published', carryText: '' })
  })

  it('does not split decimals and splits CJK sentences that have no space after the mark', () => {
    expect(prepareCommitOfText('It rose to 3.5 percent in the end')).toMatchObject({
      text: 'It rose to 3.5 percent in the end',
      carryText: '',
    })
    expect(prepareCommitOfText('我们昨天去了公园。今天天气很好我们去散步')).toMatchObject({
      text: '我们昨天去了公园。',
      carryText: '今天天气很好我们去散步',
    })
  })

  it('keeps the whole text for a pause or gap commit and when a split rule is switched off', () => {
    const sentence = 'First sentence ends here. Second part'
    const clause = 'Yesterday we walked along the river for hours, then left'
    const dangling = 'The results were published in the'

    expect(prepareCommitOfText(sentence, {}, false)).toMatchObject({ text: sentence, carryText: '', carryAudioMs: 0 })
    expect(prepareCommitOfText(sentence, { carrySentenceTail: false })).toMatchObject({ text: sentence, carryText: '' })
    expect(prepareCommitOfText(sentence, { sentenceCarryShare: 0.2 })).toMatchObject({ text: sentence, carryText: '' })
    expect(prepareCommitOfText(clause, { clauseCarryShare: 0 })).toMatchObject({ text: clause, carryText: '' })
    expect(prepareCommitOfText(dangling, { carryDanglingWords: false })).toMatchObject({ text: dangling, carryText: '' })
  })
})

describe('early caption cut at a sentence end', () => {
  // 20 frames (640 ms) is the length limit, so a sentence may close the caption from 10 frames (320 ms) on.
  const TARGET_FRAMES = 20
  const SENTENCE = 'One two three four five six seven eight nine ten.'

  function withLiveText(text: string, options: Partial<LiveSpeechAccumulatorOptions> = {}) {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: TARGET_FRAMES * FRAME_MS, pauseWaitMs: 0, ...options })
    accumulator.acceptResult(liveResult({ resultId: 1, audioEndMs: 32, text }), 100)
    return { accumulator, send: createStream(accumulator) }
  }

  /** Frames fed before the length limit; the number of the first one that crossed the target, or 0 if none did. */
  function firstCutFrame(text: string, options: Partial<LiveSpeechAccumulatorOptions> = {}): number {
    const { send } = withLiveText(text, options)
    return sendFrames(send, TARGET_FRAMES - 1).findIndex((result) => result.targetCrossed) + 1
  }

  it('closes the caption at a late enough sentence end with enough words after it, before the length limit', () => {
    const { send } = withLiveText(`${SENTENCE} Then these words follow`)
    const results = sendFrames(send, TARGET_FRAMES - 1)
    const cutFrame = results.findIndex((result) => result.targetCrossed) + 1

    // The sentence holds 49 of the 73 characters, so its estimated time reaches half the limit at frame 15.
    expect(cutFrame).toBeGreaterThanOrEqual(TARGET_FRAMES / 2)
    expect(cutFrame).toBeLessThan(TARGET_FRAMES)
    expect(results[cutFrame - 1]).toEqual({ targetCrossed: true, pendingText: true })
    // Without a sentence end the same caption runs to the length limit.
    expect(firstCutFrame(`${SENTENCE.slice(0, -1)} Then these words follow`)).toBe(0)
  })

  it('does not cut at a sentence end that is too early in the caption', () => {
    // Same three words after the period, but the sentence is short: its estimated time stays below half the limit.
    expect(firstCutFrame('Hi. Then these words follow')).toBe(0)
    expect(firstCutFrame(`${SENTENCE} Then these words follow`)).not.toBe(0)
  })

  it('needs at least three words after the sentence end', () => {
    expect(firstCutFrame(`${SENTENCE} Then these`)).toBe(0)
    expect(firstCutFrame(`${SENTENCE} Then these words`)).not.toBe(0)
    expect(firstCutFrame(`${SENTENCE} Then these`, { earlyWordsAfter: 2 })).not.toBe(0)
  })

  it('cuts only at the length limit when the early cut is switched off', () => {
    expect(firstCutFrame(`${SENTENCE} Then these words follow`, { earlySentenceShare: 0 })).toBe(0)

    const { send } = withLiveText(`${SENTENCE} Then these words follow`, { earlySentenceShare: 0 })
    const results = sendFrames(send, TARGET_FRAMES)
    expect(results[TARGET_FRAMES - 1]).toEqual({ targetCrossed: true, pendingText: true })
  })

  it('does not cut at a period inside the carried words', () => {
    const carryingText = 'Alpha beta gamma delta epsilon. Zeta eta theta iota kappa lambda.'
    const liveAfterCarry = 'Zeta eta theta iota kappa lambda. mu nu xi'

    const carrying = new LiveSpeechAccumulator({
      language: 'en',
      targetMs: TARGET_FRAMES * FRAME_MS,
      pauseWaitMs: 0,
      carryCountsTowardNext: false,
    })
    const send = createStream(carrying)
    sendFrames(send, 100)
    carrying.acceptResult(liveResult({ resultId: 1, audioStartMs: 0, audioEndMs: 3_200, text: carryingText, isFinal: true }), 100)
    // The provider ended the carried words with a period at the forced flush; the live text continues after it.
    const first = readyCommit(carrying.prepareCommit(3_200, 3_200, true))
    expect(first.carryText).toBe('Zeta eta theta iota kappa lambda.')
    carrying.completeCommit(first)
    carrying.acceptResult(liveResult({ resultId: 2, audioStartMs: 3_200, audioEndMs: 3_300, text: 'mu nu xi' }), 200)
    expect(carrying.liveOriginal).toBe(liveAfterCarry)

    // The same live text, with the period spoken in this caption, cuts early at the same elapsed time.
    expect(firstCutFrame(liveAfterCarry)).not.toBe(0)
    expect(sendFrames(send, TARGET_FRAMES - 1).some((result) => result.targetCrossed)).toBe(false)
  })
})

describe('wait for a pause before a length cut', () => {
  const TARGET_FRAMES = 20
  // 400 ms is 12.5 frames: the wait that began at the target frame expires at the 13th frame after it.
  const PAUSE_WAIT_FRAMES = 13
  const LOUD = 1_000
  // A frame is a pause at or below 20% of the recent speech peak.
  const QUIET = 100
  const DIP_ABOVE_PAUSE_LEVEL = 300

  function withPendingText(options: Partial<LiveSpeechAccumulatorOptions> = {}) {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: TARGET_FRAMES * FRAME_MS, ...options })
    accumulator.acceptResult(liveResult({ resultId: 1, audioEndMs: 32, text: 'words still pending' }), 100)
    return { accumulator, send: createStream(accumulator) }
  }

  it('waits 400 ms past the length limit when the audio has no pause, then flushes', () => {
    const { send } = withPendingText()
    const results = sendFrames(send, TARGET_FRAMES + PAUSE_WAIT_FRAMES, LOUD)

    expect(results.slice(0, TARGET_FRAMES + PAUSE_WAIT_FRAMES - 1).some((result) => result.targetCrossed)).toBe(false)
    expect(results[TARGET_FRAMES + PAUSE_WAIT_FRAMES - 1]).toEqual({ targetCrossed: true, pendingText: true })
  })

  it('flushes at the first quiet frame of the wait and starts the next caption there', () => {
    const { accumulator, send } = withPendingText()
    sendFrames(send, TARGET_FRAMES + 3, LOUD)

    expect(send(DIP_ABOVE_PAUSE_LEVEL)).toEqual({ targetCrossed: false, pendingText: false })
    expect(send(QUIET)).toEqual({ targetCrossed: true, pendingText: true })
    // The wait did not move the grid: the next caption starts at the frame that flushed.
    expect(accumulator.registerFinalize('cap')).toMatchObject({ targetStartMs: (TARGET_FRAMES + 5) * FRAME_MS })
  })

  it('flushes at once when the frame at the limit is already quiet, nothing is pending, or the wait is off', () => {
    const quietAtLimit = withPendingText()
    sendFrames(quietAtLimit.send, TARGET_FRAMES - 1, LOUD)
    expect(quietAtLimit.send(QUIET)).toEqual({ targetCrossed: true, pendingText: true })

    const nothingPending = new LiveSpeechAccumulator({ language: 'en', targetMs: TARGET_FRAMES * FRAME_MS })
    const nothingPendingResults = sendFrames(createStream(nothingPending), TARGET_FRAMES, LOUD)
    expect(nothingPendingResults[TARGET_FRAMES - 1]).toEqual({ targetCrossed: true, pendingText: false })

    const waitOff = withPendingText({ pauseWaitMs: 0 })
    const waitOffResults = sendFrames(waitOff.send, TARGET_FRAMES, LOUD)
    expect(waitOffResults[TARGET_FRAMES - 1]).toEqual({ targetCrossed: true, pendingText: true })
  })

  it('makes an early sentence cut wait for a pause as well', () => {
    const live = 'One two three four five six seven eight nine ten. Then these words follow'
    const waiting = withPendingText()
    waiting.accumulator.acceptResult(liveResult({ resultId: 2, audioEndMs: 64, text: live }), 110)
    expect(sendFrames(waiting.send, TARGET_FRAMES - 1, LOUD).some((result) => result.targetCrossed)).toBe(false)

    const quiet = withPendingText()
    quiet.accumulator.acceptResult(liveResult({ resultId: 2, audioEndMs: 64, text: live }), 110)
    // The sentence qualifies by frame 15; the quiet frame right after it ends the caption well before the limit.
    sendFrames(quiet.send, 15, LOUD)
    expect(quiet.send(QUIET)).toEqual({ targetCrossed: true, pendingText: true })
  })

  it('starts a fresh window when a phrase commit lands during the wait', () => {
    const { accumulator, send } = withPendingText()
    sendFrames(send, TARGET_FRAMES + 1, LOUD)

    const commit = accumulator.acceptResult(liveResult({
      resultId: 2,
      audioStartMs: 0,
      audioEndMs: (TARGET_FRAMES + 1) * FRAME_MS,
      text: 'words',
      isFinal: true,
      speechFinal: true,
    }), 200)
    if (commit.kind !== 'commit') throw new Error('Expected a phrase commit')
    accumulator.completeCommit(readyCommit(accumulator.prepareCommit(commit.boundaryAudioMs, commit.targetStartMs)))
    accumulator.acceptResult(liveResult({
      resultId: 3,
      audioStartMs: commit.boundaryAudioMs,
      audioEndMs: commit.boundaryAudioMs + FRAME_MS,
      text: 'next phrase',
    }), 210)

    // The expired wait would flush here; the next phrase has a whole window of its own.
    expect(sendFrames(send, PAUSE_WAIT_FRAMES + TARGET_FRAMES - 2, LOUD).some((result) => result.targetCrossed)).toBe(false)
  })
})

describe('carried words and the next caption length', () => {
  function commitWithCarry(options: Partial<LiveSpeechAccumulatorOptions> = {}) {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000, ...options })
    const send = createStream(accumulator, 1_000)
    sendFrames(send, 100)
    accumulator.acceptResult(liveResult({
      resultId: 1,
      audioStartMs: 0,
      audioEndMs: 3_200,
      text: 'Alpha beta gamma delta. Epsilon zeta eta',
      isFinal: true,
    }), 100)
    const ready = readyCommit(accumulator.prepareCommit(3_200, 3_200, true))
    accumulator.completeCommit(ready)
    return { accumulator, send, ready }
  }

  it('counts the carried words toward the next caption, which therefore ends sooner', () => {
    const { accumulator, send, ready } = commitWithCarry()

    // 16 of the 40 characters carry over: 1280 of the 3200 ms. The caption ends where they begin (1920 ms).
    expect(ready).toMatchObject({ carryText: 'Epsilon zeta eta', carryAudioMs: 1_280, carryStartAudioMs: 1_920, endedAt: 2_979 })
    expect(accumulator.liveOriginal).toBe('Epsilon zeta eta')
    expect(accumulator.registerFinalize('cap')).toMatchObject({ targetStartMs: 1_920 })

    // The next caption has 6000 - 1280 = 4720 ms left, i.e. 148 frames (4736 ms).
    const cutFrame = sendFrames(send, 188).findIndex((result) => result.targetCrossed) + 1
    expect(cutFrame).toBe(148)
  })

  it('starts the next caption at the boundary when the carried words do not count', () => {
    const { accumulator, send, ready } = commitWithCarry({ carryCountsTowardNext: false })

    // The caption keeps its whole confirmed span, 3200 ms (mapped through the anchor of frame 99), and the carried
    // words open the next window at the boundary: a full 6000 ms, i.e. 188 frames (6016 ms).
    expect(ready).toMatchObject({ carryText: 'Epsilon zeta eta', carryAudioMs: 1_280, carryStartAudioMs: 3_200, endedAt: 4_299 })
    expect(accumulator.registerFinalize('cap')).toMatchObject({ targetStartMs: 3_200 })
    const cutFrame = sendFrames(send, 188).findIndex((result) => result.targetCrossed) + 1
    expect(cutFrame).toBe(188)
  })

  it('starts the carried words from the end of the confirmed text when the flush boundary is later', () => {
    const accumulator = new LiveSpeechAccumulator({ language: 'en', targetMs: 6_000 })
    const send = createStream(accumulator, 1_000)
    sendFrames(send, 120)
    accumulator.acceptResult(liveResult({
      resultId: 1,
      audioStartMs: 0,
      audioEndMs: 3_200,
      text: 'Alpha beta gamma delta. Epsilon zeta eta',
      isFinal: true,
    }), 100)

    // Trailing silence: the flush answers at 3520 ms, 320 ms after the last confirmed word. The carried words
    // still start at 3200 - 1280 = 1920 ms; the later boundary must not shift them.
    const first = readyCommit(accumulator.prepareCommit(3_520, 3_520, true))
    expect(first).toMatchObject({
      boundaryAudioMs: 3_520,
      carryText: 'Epsilon zeta eta',
      carryAudioMs: 1_280,
      carryStartAudioMs: 1_920,
      endedAt: 2_979,
    })
    accumulator.completeCommit(first)
    expect(accumulator.confirmedBoundaryMs).toBe(3_200)

    accumulator.acceptResult(liveResult({
      resultId: 2,
      audioStartMs: 3_520,
      audioEndMs: 3_840,
      text: 'theta iota.',
      isFinal: true,
    }), 200)

    // The carried start maps through the anchor of frame 60 (1920 ms). Started at the boundary it would be
    // 3520 - 1280 = 2240 ms (frame 70), i.e. 3310.
    expect(accumulator.prepareCommit(3_840, 3_840)).toMatchObject({
      kind: 'ready',
      text: 'Epsilon zeta eta theta iota.',
      carryText: '',
      startedAt: 2_980,
      endedAt: 4_959,
    })
  })
})

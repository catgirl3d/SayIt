import { FRAME_BYTES, FRAME_MS } from './subtitleSegmentation'
import type { SegmentCloseReason } from './pipelineTrace'
import type { LiveAsrResult } from './transcription/types'

// Cap the displayed live phrase at 16 KiB of UTF-8 text; an oversized phrase stops live recognition.
const MAX_LIVE_PHRASE_BYTES = 16 * 1024
// Accept at most 64 intra-frame capture anchors in one native frame.
const MAX_FRAME_CAPTURE_ANCHORS = 64
// Live audio-to-capture-time anchors are retained back to the committed watermark, because uncommitted speech
// must stay mappable however many anchors the source jitter produced while it was spoken. This hard bound only
// stops a stream that never commits from growing the list without limit.
const MAX_LIVE_TIME_ANCHORS = 4096
// Bound unmatched live finalize requests at 32; retire the oldest frontier when the bound is reached.
const MAX_LIVE_FINALIZE_REQUESTS = 32
// Require 512 ms (16 frame periods) of native capture time beyond the last audio end before accepting idle confirmation.
const LIVE_IDLE_CONFIRMATION_US = 512_000
// Allow 4 microseconds of timestamp tolerance when validating live frame duration and detecting source gaps.
// Must match CAPTURE_TIME_TOLERANCE_US in client/src-tauri/src/commands/system_audio.rs; change both together.
const LIVE_CAPTURE_TIME_TOLERANCE_US = 4
// Once the caption length is reached, wait up to this much more audio for a pause between words before the
// flush: Deepgram re-decodes a word that straddles a forced Finalize, so that word comes back duplicated,
// split, or not at all.
const LIVE_PAUSE_WAIT_MS = 400
// A frame is a pause between words when its RMS level falls to this share of the recent speech peak.
const LIVE_PAUSE_LEVEL_RATIO = 0.2
// The recent speech peak decays by this factor per frame, halving in about a second.
const LIVE_SPEECH_PEAK_DECAY = 0.98
// A sentence end may close a caption before its length limit once the caption reaches this share of it.
const LIVE_EARLY_SENTENCE_SHARE = 1 / 2
// Words of the next sentence the live text must show before that early cut. The flush leaves its last words
// without what follows them, and cutting right after a period turned "Well," into "While" and dropped "The".
const LIVE_EARLY_WORDS_AFTER = 3
// Sentence-final punctuation inside a text, optionally followed by closing quotes or brackets: Latin marks
// only before whitespace, so decimals and "U.S" do not split; CJK marks anywhere, as those scripts put no
// space after them.
const SENTENCE_BREAK = /[.!?]["'”’»)\]]*(?=\s)|[。！？]["'”’»)\]]*/gu
// The same sentence end, also at the very end of the text: the freshest live period has nothing after it yet.
const SENTENCE_BREAK_OR_END = /[.!?]["'”’»)\]]*(?=\s|$)|[。！？]["'”’»)\]]*/gu
// Clause punctuation inside a text, with the same whitespace rule for Latin marks.
const CLAUSE_BREAK = /[,;:]["'”’»)\]]*(?=\s)|[，、；：]["'”’»)\]]*/gu
// A cap commit ends its caption at the last sentence end when no more than this share of the text follows
// it; that remainder opens the next caption. A longer remainder means the sentence ended too early to cut.
const MAX_SENTENCE_CARRY_SHARE = 0.6
// Without a qualifying sentence end, the last clause break may end the caption when no more than this share
// follows it; a clause break is a weaker boundary, so it must sit closer to the end.
const MAX_CLAUSE_CARRY_SHARE = 1 / 3

interface CaptionSplit {
  head: string
  carry: string
}

/** Splits text after the last `pattern` match when no more than `maxShare` of the text follows it. */
function splitAfterLast(text: string, pattern: RegExp, maxShare: number): CaptionSplit | null {
  let cut = -1
  for (const match of text.matchAll(pattern)) cut = match.index + match[0].length
  if (cut <= 0) return null
  const head = text.slice(0, cut).trim()
  const carry = text.slice(cut).trim()
  if (!head || !carry || carry.length > text.length * maxShare) return null
  return { head, carry }
}

// Words that lean on the word after them (articles, prepositions, conjunctions, determiners) in English,
// Ukrainian, and Russian. Auxiliaries and pronouns are left out: they also end clauses ("could be", "told her").
const DANGLING_WORDS = new Set([
  'a', 'an', 'the', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'by', 'from', 'as', 'and', 'or', 'but', 'nor',
  'that', 'which', 'who', 'whose', 'than', 'into', 'onto', 'about', 'over', 'under', 'after', 'before', 'between',
  'through', 'during', 'without', 'within', 'against', 'among', 'if', 'because', 'while', 'its', 'their', 'his',
  'our', 'my', 'your', 'this', 'these', 'those', 'every', 'each',
  'і', 'й', 'та', 'а', 'але', 'або', 'чи', 'в', 'у', 'на', 'з', 'із', 'зі', 'до', 'по', 'про', 'від', 'за', 'для',
  'при', 'через', 'над', 'під', 'перед', 'між', 'без', 'після', 'що', 'щоб', 'як', 'якщо', 'коли', 'бо', 'наш',
  'наша', 'наше', 'наші', 'свій', 'своя', 'своє', 'свої', 'цей', 'ця', 'ці', 'який', 'яка', 'яке', 'які',
  'и', 'но', 'или', 'во', 'с', 'со', 'к', 'ко', 'о', 'об', 'от', 'из', 'для', 'между', 'после', 'чтобы', 'если',
  'когда', 'потому', 'который', 'которая', 'которое', 'которые', 'этот', 'эта', 'эти', 'наша', 'наши', 'свой',
  'своё', 'свои',
])
// A number leans on the unit or noun after it; a spelled-out number moves together with all of its words.
const NUMBER_WORD = /^(?:\d[\d.,]*%?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|тисяч[аі]?|мільйон\p{L}*|мільярд\p{L}*|тысяч[аи]?|миллион\p{L}*|миллиард\p{L}*)$/u
// At most this many trailing words move to the next caption when no punctuation qualifies.
const MAX_DANGLING_WORDS = 4

/** Moves words at the end that only make sense with what follows them (a preposition, an article, a number). */
function splitBeforeDanglingWords(text: string, maxShare: number): CaptionSplit | null {
  const words = text.split(/\s+/)
  let keep = words.length
  while (keep > 1 && words.length - keep < MAX_DANGLING_WORDS) {
    const word = words[keep - 1]!
    // Punctuation after a word is a boundary of its own.
    if (/[.,;:!?…"'”’»)\]]$/u.test(word)) break
    const bare = word.toLowerCase()
    if (!DANGLING_WORDS.has(bare) && !NUMBER_WORD.test(bare)) break
    keep -= 1
  }
  if (keep === words.length) return null
  const carry = words.slice(keep).join(' ')
  if (carry.length > text.length * maxShare) return null
  return { head: words.slice(0, keep).join(' '), carry }
}

/**
 * Ends a cap caption at its last sentence end, else at its last clause break, when the remainder is short;
 * without either, words at the end that lean on the next words move with them.
 */
function splitCaption(text: string, sentenceShare: number, clauseShare: number, carryDangling: boolean): CaptionSplit {
  return splitAfterLast(text, SENTENCE_BREAK, sentenceShare)
    ?? (clauseShare > 0 ? splitAfterLast(text, CLAUSE_BREAK, clauseShare) : null)
    ?? (carryDangling ? splitBeforeDanglingWords(text, MAX_CLAUSE_CARRY_SHARE) : null)
    ?? { head: text, carry: '' }
}

/** RMS level of a little-endian PCM16 frame. */
function frameRms(audio: Uint8Array): number {
  const view = new DataView(audio.buffer, audio.byteOffset, audio.byteLength)
  let sum = 0
  for (let offset = 0; offset + 1 < audio.byteLength; offset += 2) {
    const sample = view.getInt16(offset, true)
    sum += sample * sample
  }
  return Math.sqrt(sum / Math.max(1, audio.byteLength >> 1))
}

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
  /** Extra audio to wait past targetMs for a pause between words before the flush; 0 flushes at targetMs. */
  readonly pauseWaitMs?: number
  /** Share of the recent speech peak at or below which a frame's RMS level counts as a pause. */
  readonly pauseLevelRatio?: number
  /** Consecutive frames at or below that level that make a pause; one frame also catches dips inside connected speech. */
  readonly pauseFrames?: number
  /** Whether a cap commit ends at the last sentence end and carries the short remainder into the next caption. */
  readonly carrySentenceTail?: boolean
  /** Largest share of a cap caption that may follow its last sentence end and move to the next caption. */
  readonly sentenceCarryShare?: number
  /** Largest share that may follow the last clause break when no sentence end qualifies; 0 disables it. */
  readonly clauseCarryShare?: number
  /** Whether the carried words count toward the next caption's length, so it is not longer by their duration. */
  readonly carryCountsTowardNext?: boolean
  /**
   * Shortest caption, as a share of targetMs, that a sentence end may close before the length limit is reached;
   * 0 cuts only at the limit.
   */
  readonly earlySentenceShare?: number
  /**
   * Words of the next sentence the live text must show before an early cut: the flush leaves the last words
   * without what follows them, and a sentence's first words are the hardest to recognize that way.
   */
  readonly earlyWordsAfter?: number
  /** Whether a cap caption without usable punctuation hands words that lean on the next ones to the next caption. */
  readonly carryDanglingWords?: boolean
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
  readonly pendingText: boolean
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
  /** Confirmed text after the caption's last sentence end; it opens the next caption instead. */
  readonly carryText: string
  /** Estimated audio the carried text takes, from its share of the confirmed text. */
  readonly carryAudioMs: number
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
  private readonly pauseWaitMs: number
  private readonly pauseLevelRatio: number
  private readonly pauseFrames: number
  private readonly carrySentenceTail: boolean
  private readonly sentenceCarryShare: number
  private readonly clauseCarryShare: number
  private readonly carryCountsTowardNext: boolean
  private readonly earlySentenceShare: number
  private readonly earlyWordsAfter: number
  private readonly carryDanglingWords: boolean
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
  private pauseWaitStartMs: number | null = null
  private speechPeak = 0
  private quietFrames = 0
  private carriedChars = 0
  private finalizedFrontierMs = -1
  private finalizeRequests: LiveFinalizeRequest[] = []
  private lastFinalizeRequest: LiveFinalizeRequest | null = null
  private finalizeRetiredThroughMs = -1

  constructor(options: LiveSpeechAccumulatorOptions) {
    this.language = options.language
    this.targetMs = options.targetMs
    this.pauseWaitMs = options.pauseWaitMs ?? LIVE_PAUSE_WAIT_MS
    this.pauseLevelRatio = options.pauseLevelRatio ?? LIVE_PAUSE_LEVEL_RATIO
    this.pauseFrames = options.pauseFrames ?? 1
    this.carrySentenceTail = options.carrySentenceTail ?? true
    this.sentenceCarryShare = options.sentenceCarryShare ?? MAX_SENTENCE_CARRY_SHARE
    this.clauseCarryShare = options.clauseCarryShare ?? MAX_CLAUSE_CARRY_SHARE
    this.carryCountsTowardNext = options.carryCountsTowardNext ?? true
    this.earlySentenceShare = options.earlySentenceShare ?? LIVE_EARLY_SENTENCE_SHARE
    this.earlyWordsAfter = options.earlyWordsAfter ?? LIVE_EARLY_WORDS_AFTER
    this.carryDanglingWords = options.carryDanglingWords ?? true
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
    this.pauseWaitStartMs = null
    this.speechPeak = 0
    this.quietFrames = 0
    this.carriedChars = 0
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
      || !Array.isArray(frame.captureAnchors) || frame.captureAnchors.length > MAX_FRAME_CAPTURE_ANCHORS) {
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

  markFrameSent(audio: Uint8Array): LiveFrameSendResult {
    this.audioFrontierMs += FRAME_MS
    const level = frameRms(audio)
    this.quietFrames = level <= this.speechPeak * this.pauseLevelRatio ? this.quietFrames + 1 : 0
    const pause = this.quietFrames >= this.pauseFrames
    this.speechPeak = Math.max(level, this.speechPeak * LIVE_SPEECH_PEAK_DECAY)
    if (this.pauseWaitStartMs !== null) {
      // Past the caption length: flush in the first pause between words, or when the wait runs out.
      if (!pause && this.audioFrontierMs - this.pauseWaitStartMs < this.pauseWaitMs) {
        return {
          targetCrossed: false,
          pendingText: false,
        }
      }
      this.pauseWaitStartMs = null
      this.targetStartMs = this.audioFrontierMs
      return {
        targetCrossed: true,
        pendingText: this.hasPendingText(),
      }
    }
    const elapsedMs = this.audioFrontierMs - this.targetStartMs
    if (elapsedMs < this.targetMs && !this.sentenceEndedLongEnough(elapsedMs)) {
      return {
        targetCrossed: false,
        pendingText: false,
      }
    }

    // Both the limit and an early sentence end flush through the same path, which moves the grid start to
    // the frontier; so the period still shown until the flush answers cannot request a second flush.
    const pendingText = this.hasPendingText()
    if (pendingText && !pause && this.pauseWaitMs > 0) {
      // The grid start moves only at the real flush: registerFinalize snapshots it into the request,
      // so the wait does not shorten the next caption.
      this.pauseWaitStartMs = this.audioFrontierMs
      return {
        targetCrossed: false,
        pendingText: false,
      }
    }
    this.targetStartMs = this.audioFrontierMs
    return {
      targetCrossed: true,
      pendingText,
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

  /** Whether the paused stream moved past the last flush request, so a pause needs a finalize of its own. */
  shouldFinalizeOnGap(): boolean {
    return this.audioFrontierMs > this.finalizedFrontierMs
  }

  /** End of the confirmed text that a flush settles; null while nothing is confirmed yet. */
  get confirmedBoundaryMs(): number | null {
    return this.confirmedText ? this.confirmedEndMs : null
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

  /** `atSentence` ends a cap commit at its last sentence end and keeps the short remainder for the next caption. */
  prepareCommit(boundaryAudioMs: number, targetStartMs = this.audioFrontierMs, atSentence = false): LiveCommitPreparation {
    if (boundaryAudioMs <= this.committedWatermark) return { kind: 'none' }
    const confirmed = this.confirmedText.trim()
    const { head: text, carry: carryText } = atSentence && this.carrySentenceTail
      ? splitCaption(confirmed, this.sentenceCarryShare, this.clauseCarryShare, this.carryDanglingWords)
      : { head: confirmed, carry: '' }
    const startAudioMs = this.confirmedStartMs
    const confirmedEndAudioMs = text && this.confirmedEndMs > 0 ? this.confirmedEndMs : boundaryAudioMs
    // The carried words take roughly their share of the confirmed speech, at its end.
    const carryAudioMs = carryText && startAudioMs !== null
      ? Math.round((confirmedEndAudioMs - startAudioMs) * carryText.length / confirmed.length)
      : 0
    const endAudioMs = confirmedEndAudioMs - (this.carryCountsTowardNext ? carryAudioMs : 0)
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
        carryText,
        carryAudioMs,
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
      carryText,
      carryAudioMs: 0,
    }
  }

  completeCommit(commit: LiveCommitReady): LiveCommitCompletion {
    this.committedWatermark = Math.max(this.committedWatermark, commit.boundaryAudioMs)
    // Carried words were spoken just before the boundary. When they count toward the next caption, their start
    // is estimated from their share of the confirmed speech; otherwise the next caption starts at the boundary.
    const carry = commit.carryText
    const carryLeadMs = carry && this.carryCountsTowardNext ? commit.carryAudioMs : 0
    const carryStartMs = commit.boundaryAudioMs - carryLeadMs
    // Accepted results never start before the watermark, and carried words start at carryStartMs, so only the
    // last anchor at or before the earlier of the two is still needed.
    const retainFromMs = Math.min(this.committedWatermark, carryStartMs)
    while (this.timeAnchors.length > 1 && this.timeAnchors[1]!.audioMs <= retainFromMs) this.timeAnchors.shift()
    this.confirmedText = carry
    this.carriedChars = carry.length
    this.confirmedStartMs = carry ? carryStartMs : null
    this.confirmedEndMs = carry ? commit.boundaryAudioMs : 0
    this.confirmedAt = carry ? commit.confirmedAt : null
    if (this.interimStartMs === null || this.interimEndMs <= commit.boundaryAudioMs) {
      this.interimText = ''
      this.interimStartMs = null
      this.interimEndMs = 0
    }
    this.phraseStartMs = carry ? carryStartMs : this.interimStartMs
    if (this.phraseStartMs === null) {
      this.phraseEngine = ''
      this.phraseModel = ''
    }
    this.targetStartMs = commit.targetStartMs - carryLeadMs
    // A pause or gap commit can land during the wait for a pause between words; the next phrase starts its own window.
    this.pauseWaitStartMs = null
    return { liveOriginal: this.liveOriginal }
  }

  private hasPendingText(): boolean {
    return Boolean(this.confirmedText.trim() || this.interimText.trim())
  }

  // A sentence in the live text ended late enough to close the caption before its length limit. Its time is
  // estimated from its share of the text, as the split estimates carried words, so the two agree on what is
  // too short; the live text lags the audio, and the commit split carries what was said after the period.
  private sentenceEndedLongEnough(elapsedMs: number): boolean {
    const minMs = this.targetMs * this.earlySentenceShare
    if (minMs <= 0 || elapsedMs < minMs) return false
    const text = this.liveOriginal
    let cut = -1
    for (const match of text.matchAll(SENTENCE_BREAK_OR_END)) cut = match.index + match[0].length
    // A period inside the carried words may be one the provider added at the previous forced flush.
    if (cut <= this.carriedChars || (cut / text.length) * elapsedMs < minMs) return false
    return (text.slice(cut).match(/\S+/g)?.length ?? 0) >= this.earlyWordsAfter
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

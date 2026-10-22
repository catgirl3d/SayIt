// Text cleanup for batch subtitle pieces. A piece is a separate ASR request, so its text needs two fixes that
// the recognizer cannot make on its own: an ellipsis that only marks the audio cut, and a capital letter that
// only a new utterance would start with.

// Trailing sentence enders, including the CJK full-width forms (U+3002, U+FF1F, U+FF01) written as escapes;
// a closing quote or bracket may follow them, including CJK ones (U+FF09, U+300D, U+300F).
const SENTENCE_END = /[.?!\u2026\u3002\uFF1F\uFF01]['"\u201D\u2019\u00BB)\]}\uFF09\u300D\u300F]*$/u
// A cut that lands mid-speech leaves an ellipsis at the end of the text, which the recognizer adds to show the cut.
const TRAILING_ELLIPSIS = /\s*(?:\.{3,}|…)$/u

export interface BatchPieceContext {
  /** The piece was closed by a pause or length-limit cut, so its end is an audio cut, not the end of speech. */
  readonly cutMidSpeech: boolean
  /** The piece continues an unfinished sentence that the previous recognized piece left open. */
  readonly continuesUnfinishedSentence: boolean
  /** Session source language: 'auto', or a code such as 'en' or 'de-DE'. */
  readonly language: string
}

/** True when the text ends a sentence, so a following piece starts a new one. */
export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim())
}

// German capitalizes every noun, so lowering the first letter of a continuation would corrupt the text.
function isGerman(language: string): boolean {
  return language.trim().toLowerCase().split(/[-_]/)[0] === 'de'
}

// "I" and its contractions (I'm, I've, I'll, I'd) stay capitalized wherever they occur.
// An all-caps word of two or more letters is an acronym (NASA, BBC), not a capitalized word.
function keepsLeadingCapital(text: string): boolean {
  const leadingWord = /^\p{L}+/u.exec(text)?.[0] ?? ''
  if (leadingWord === 'I') return true
  return leadingWord.length >= 2 && leadingWord === leadingWord.toLocaleUpperCase()
}

/**
 * Returns the caption text of one batch piece: a mid-speech ellipsis is removed, and the first letter is lowered
 * when the piece continues an unfinished sentence. An empty result means nothing was recognized beyond the cut marker.
 */
export function cleanBatchCaptionText(text: string, piece: BatchPieceContext): string {
  let cleaned = text.trim()
  if (piece.cutMidSpeech) cleaned = cleaned.replace(TRAILING_ELLIPSIS, '').trim()
  if (!piece.continuesUnfinishedSentence || isGerman(piece.language)) return cleaned
  if (!/^\p{Lu}/u.test(cleaned) || keepsLeadingCapital(cleaned)) return cleaned
  const first = String.fromCodePoint(cleaned.codePointAt(0)!)
  return first.toLowerCase() + cleaned.slice(first.length)
}

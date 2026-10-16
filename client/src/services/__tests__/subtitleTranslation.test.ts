import { describe, expect, it } from 'vitest'
import {
  buildSubtitlePrompt,
  CONTEXT_MAX_CHARS,
  CONTEXT_MAX_GAP_MS,
  RecentSpeech,
  subtitleLanguageName,
} from '../subtitleTranslation'

describe('subtitle language name', () => {
  it('resolves the English name of a target language code', () => {
    expect(subtitleLanguageName('ru')).toBe('Russian')
    expect(subtitleLanguageName('uk')).toBe('Ukrainian')
    expect(subtitleLanguageName('en')).toBe('English')
  })

  it('fails loudly for a code that has no language name', () => {
    expect(() => subtitleLanguageName('zz')).toThrow('zz')
  })
})

describe('subtitle prompt', () => {
  it('names the target language and tells the model to translate only the fragment', () => {
    const prompt = buildSubtitlePrompt('Ukrainian')
    expect(prompt).toContain('into Ukrainian')
    expect(prompt).toContain('<asr_text>')
    expect(prompt).toContain('<text_before>')
    expect(prompt).toContain('never translate or repeat')
  })

  it('stays short enough for small local models', () => {
    expect(buildSubtitlePrompt('Russian').length).toBeLessThan(1100)
  })
})

describe('recent speech context', () => {
  const span = (startedAt: number, endedAt: number) => ({ startedAt, endedAt })

  it('is empty before anything was recognized', () => {
    expect(new RecentSpeech().contextBefore(1_000)).toBe('')
  })

  it('returns the previous segments in spoken order, no more than six', () => {
    const recent = new RecentSpeech()
    recent.push('first', span(0, 1_000))
    recent.push('second', span(1_000, 2_000))
    recent.push('third', span(2_000, 3_000))

    expect(recent.contextBefore(3_000)).toBe('first second third')
  })

  it('drops segments older than the window', () => {
    const recent = new RecentSpeech()
    for (let index = 1; index <= 7; index++) recent.push(`segment ${index}`, span(index * 1_000, (index + 1) * 1_000))

    expect(recent.contextBefore(8_000)).toBe('segment 2 segment 3 segment 4 segment 5 segment 6 segment 7')
  })

  it('drops everything once the pause before the next segment is too long', () => {
    const recent = new RecentSpeech()
    recent.push('old scene', span(0, 1_000))

    expect(recent.contextBefore(1_000 + CONTEXT_MAX_GAP_MS)).toBe('old scene')
    expect(recent.contextBefore(1_000 + CONTEXT_MAX_GAP_MS + 1)).toBe('')
  })

  it('keeps only the part of a chain that is still continuous', () => {
    const recent = new RecentSpeech()
    recent.push('stale', span(0, 1_000))
    recent.push('recent', span(1_000 + CONTEXT_MAX_GAP_MS + 500, 9_000))

    expect(recent.contextBefore(9_500)).toBe('recent')
  })

  it('tolerates a next segment that starts before the previous one ended', () => {
    const recent = new RecentSpeech()
    recent.push('overlapping', span(0, 2_000))

    expect(recent.contextBefore(1_500)).toBe('overlapping')
  })

  it('clips to the most recent characters without splitting a surrogate pair', () => {
    const recent = new RecentSpeech()
    recent.push('😀'.repeat(CONTEXT_MAX_CHARS + 20), span(0, 1_000))

    const context = recent.contextBefore(1_000)
    expect(Array.from(context)).toHaveLength(CONTEXT_MAX_CHARS)
    expect(() => encodeURIComponent(context)).not.toThrow()
  })

  it('forgets everything on clear', () => {
    const recent = new RecentSpeech()
    recent.push('before restart', span(0, 1_000))
    recent.clear()

    expect(recent.contextBefore(1_000)).toBe('')
  })
})

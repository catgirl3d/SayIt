import { describe, expect, it } from 'vitest'
import {
  DANGLING_WORDS,
  ENGLISH_DANGLING_WORDS,
  ENGLISH_NUMBER_WORD,
  NUMBER_WORD,
  RUSSIAN_DANGLING_WORDS,
  RUSSIAN_NUMBER_WORD,
  UKRAINIAN_DANGLING_WORDS,
  UKRAINIAN_NUMBER_WORD,
} from '../liveCaptionWords'

const LISTS = [
  { name: 'English', words: ENGLISH_DANGLING_WORDS },
  { name: 'Ukrainian', words: UKRAINIAN_DANGLING_WORDS },
  { name: 'Russian', words: RUSSIAN_DANGLING_WORDS },
]

describe('dangling word lists', () => {
  it.each(LISTS)('$name list has no duplicates and only lowercase entries', ({ words }) => {
    expect(words.length).toBeGreaterThan(0)
    expect(new Set(words).size).toBe(words.length)
    for (const word of words) expect(word).toBe(word.toLowerCase())
  })

  it.each([
    { name: 'English', words: ENGLISH_DANGLING_WORDS, sample: ['the', 'of', 'and', 'what', 'how', 'when', 'where', 'whether'] },
    { name: 'Ukrainian', words: UKRAINIAN_DANGLING_WORDS, sample: ['і', 'та', 'що', 'як', 'коли', 'під', 'де', 'куди', 'звідки'] },
    { name: 'Russian', words: RUSSIAN_DANGLING_WORDS, sample: ['и', 'но', 'что', 'как', 'когда', 'под', 'если', 'чтобы'] },
  ])('$name list contains its representative words', ({ words, sample }) => {
    for (const word of sample) expect(words).toContain(word)
  })

  it('keeps the languages apart by their letters', () => {
    for (const word of ENGLISH_DANGLING_WORDS) expect(word).toMatch(/^[a-z]+$/)
    for (const word of UKRAINIAN_DANGLING_WORDS) expect(word).not.toMatch(/[ыэъё]/)
    for (const word of RUSSIAN_DANGLING_WORDS) expect(word).not.toMatch(/[іїєґ]/)
    for (const word of [...UKRAINIAN_DANGLING_WORDS, ...RUSSIAN_DANGLING_WORDS]) expect(word).not.toMatch(/[a-z]/)
  })

  it('lists a word valid in both Cyrillic languages in each of them', () => {
    for (const word of ['на', 'для', 'при', 'перед']) {
      expect(UKRAINIAN_DANGLING_WORDS).toContain(word)
      expect(RUSSIAN_DANGLING_WORDS).toContain(word)
    }
    expect(UKRAINIAN_DANGLING_WORDS).not.toContain('что')
    expect(RUSSIAN_DANGLING_WORDS).not.toContain('що')
  })

  it('combines the three lists, and nothing else, into the set the caption split uses', () => {
    const union = new Set([...ENGLISH_DANGLING_WORDS, ...UKRAINIAN_DANGLING_WORDS, ...RUSSIAN_DANGLING_WORDS])

    expect(DANGLING_WORDS.size).toBe(union.size)
    for (const { words } of LISTS) {
      for (const word of words) expect(DANGLING_WORDS.has(word)).toBe(true)
    }
    expect(DANGLING_WORDS.has('plan')).toBe(false)
    expect(DANGLING_WORDS.has('could')).toBe(false)
  })
})

describe('number word patterns', () => {
  it.each(['20', '3.5', '10%', '1,000', 'one', 'twenty', 'hundred', 'billion', 'тисяч', 'тисячі', 'мільйон', 'мільйонів', 'мільярд',
    'тысяч', 'тысячи', 'миллион', 'миллионов', 'миллиард'])('matches the number "%s"', (word) => {
    expect(NUMBER_WORD.test(word)).toBe(true)
  })

  it.each(['plan', 'ordinary', 'ones', 'twenty five', '20 apples', 'стіл', 'слово', 'тисячею', ''])('rejects "%s"', (word) => {
    expect(NUMBER_WORD.test(word)).toBe(false)
  })

  it('matches each spelled-out language in its own pattern only', () => {
    expect(ENGLISH_NUMBER_WORD.test('thousand')).toBe(true)
    expect(ENGLISH_NUMBER_WORD.test('тисяч')).toBe(false)
    expect(UKRAINIAN_NUMBER_WORD.test('тисячі')).toBe(true)
    expect(UKRAINIAN_NUMBER_WORD.test('тысячи')).toBe(false)
    expect(RUSSIAN_NUMBER_WORD.test('тысячи')).toBe(true)
    expect(RUSSIAN_NUMBER_WORD.test('тисячі')).toBe(false)
    expect(RUSSIAN_NUMBER_WORD.test('million')).toBe(false)
  })
})

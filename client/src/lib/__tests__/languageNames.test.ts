import { describe, expect, it } from 'vitest'
import { getLanguageDisplayName, resolveModelLanguages } from '../languageNames'

describe('getLanguageDisplayName', () => {
  it('uses localized overrides for dialect codes', () => {
    expect(getLanguageDisplayName('YUE', 'en')).toBe('Cantonese')
    expect(getLanguageDisplayName('fil', 'en')).toBe('Filipino')
    expect(getLanguageDisplayName('jw', 'en')).toBe('Javanese')
    expect(getLanguageDisplayName('yue', 'uk')).toBe('Кантонська')
    expect(getLanguageDisplayName('fil', 'uk')).toBe('Філіппінська')
    expect(getLanguageDisplayName('jw', 'uk')).toBe('Яванська')
  })
})

describe('resolveModelLanguages', () => {
  it('places the current language first and sorts the rest by localized name', () => {
    const resolved = resolveModelLanguages(['jw', 'fil', 'en', 'yue'], 'fil', 'en')

    expect(resolved.map((item) => item.code)).toEqual(['fil', 'yue', 'en', 'jw'])
    expect(resolved[0].isCurrent).toBe(true)
    expect(resolved.slice(1).every((item) => !item.isCurrent)).toBe(true)
  })
})

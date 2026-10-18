import { describe, expect, it } from 'vitest'
import { estimateHotwordTokens } from '../budget'
import {
  BUILTIN_SETS,
  composeHotwords,
  composeSelectedHotwords,
  legacyWordsToMigrate,
  normalizeBuiltinSetWords,
  removeThemeWord,
  toggleThemeWord,
  uniqueThemeName,
  withBuiltinSetDefaults,
  type CustomTheme,
} from '../model'

const PRESET_KEYS = ['agents', 'devops', 'data', 'product', 'design', 'business', 'office', 'creative']

describe('built-in AI hotword set', () => {
  it('does not ship Chinese words', () => {
    const chinese = BUILTIN_SETS.ai.words.filter((word) => /[\u3400-\u4dbf\u4e00-\u9fff]/.test(word))
    expect(chinese).toEqual([])
  })

  it('drops Chinese words that older builds saved into the set', () => {
    // Saved copies are filtered against the current defaults, so removing a word here
    // cleans existing installs on the next load.
    const savedByOldBuild = { ai: ['GPT', '豆包', '千问', '大模型', 'Claude'] }
    expect(normalizeBuiltinSetWords(savedByOldBuild)).toEqual({ ai: ['GPT', 'Claude'] })
  })
})

describe('built-in code hotword set', () => {
  const words = BUILTIN_SETS.code.words

  it('ships English terms only', () => {
    expect(words.filter((word) => !/^[\x20-\x7e]+$/.test(word))).toEqual([])
  })

  it('stays a medium-sized set', () => {
    // Built-in sets are composed ahead of custom categories, Gemini and the Qwen audio stream
    // take only the first 100 words, and Deepgram rejects more than 500 keyterm tokens.
    expect(words.length).toBeLessThanOrEqual(70)
    expect(words.join('').length).toBeLessThanOrEqual(500)
  })
})

describe('built-in hotword sets', () => {
  it('cover all ten sets', () => {
    expect(Object.keys(BUILTIN_SETS)).toEqual(['ai', 'code', ...PRESET_KEYS])
  })

  it('ship printable ASCII terms only', () => {
    for (const [key, set] of Object.entries(BUILTIN_SETS)) {
      expect(set.words.filter((word) => !/^[\x20-\x7e]+$/.test(word)), key).toEqual([])
    }
  })

  it('do not repeat words within or across sets', () => {
    // Removing a word strips it from every set at once, so a shared word would vanish from both.
    const all = Object.values(BUILTIN_SETS).flatMap((set) => set.words.map((word) => word.toLowerCase()))
    expect(all.filter((word, index) => all.indexOf(word) !== index)).toEqual([])
  })

  it('fall back to defaults for sets without a saved word list', () => {
    // Existing installs saved only the sets that existed when the store was first written.
    const filled = withBuiltinSetDefaults({ ai: ['GPT'] })
    expect(filled.ai).toEqual(['GPT'])
    expect(filled.code).toEqual(BUILTIN_SETS.code.words)
  })

  it('keep a saved empty word list instead of restoring defaults', () => {
    expect(withBuiltinSetDefaults({ code: [] }).code).toEqual([])
  })

  it('migrate legacy words that only an inactive set covers', () => {
    // GPT stays active through the AI set; Docker would be lost if the inactive code set counted.
    const migrated = legacyWordsToMigrate(
      ['Docker', 'GPT', 'my term'],
      { ai: ['GPT'], code: ['Docker'] },
      { ai: true, code: false },
    )
    expect(migrated).toEqual(['Docker', 'my term'])
  })
})

describe('built-in domain hotword presets', () => {
  // Each preset must stay compact: the whole list is sent to Deepgram in one request, and only
  // the first 100 words reach Gemini and the Qwen audio stream.
  it.each(PRESET_KEYS)('%s has 30 to 45 words', (key) => {
    expect(BUILTIN_SETS[key].words.length).toBeGreaterThanOrEqual(30)
    expect(BUILTIN_SETS[key].words.length).toBeLessThanOrEqual(45)
  })

  it.each(PRESET_KEYS)('%s stays within the per-set token estimate', (key) => {
    expect(estimateHotwordTokens(BUILTIN_SETS[key].words)).toBeLessThanOrEqual(140)
  })
})

describe('explicit category selection', () => {
  const setWords = { ai: ['GPT', 'Shared'], code: ['Git', 'Shared'] }
  const themes: CustomTheme[] = [
    { id: 'mine', name: 'Mine', words: ['SayIt', 'GPT'] },
    { id: 'other', name: 'Other', words: ['Docker'] },
  ]

  it('replaces the global active hotwords with the selected categories', () => {
    expect(composeSelectedHotwords(setWords, ['code'], themes, ['mine'])).toEqual([
      'Git',
      'Shared',
      'SayIt',
      'GPT',
    ])
  })

  it('includes a globally disabled category and leaves unselected ones out', () => {
    const selection = composeSelectedHotwords(setWords, ['ai'], themes, [])

    expect(selection).toContain('GPT')
    expect(selection).toContain('Shared')
    expect(selection).not.toContain('Git')
    expect(selection).not.toContain('Docker')
  })
})

describe('custom category word edits', () => {
  const themes: CustomTheme[] = [
    { id: 'a', name: 'Mine', words: ['Docker', 'github'] },
    { id: 'b', name: 'Other', words: ['Docker'] },
  ]

  it('removes a word from one category only', () => {
    expect(removeThemeWord(themes, 'a', 'Docker')).toEqual([
      { id: 'a', name: 'Mine', words: ['github'] },
      { id: 'b', name: 'Other', words: ['Docker'] },
    ])
  })

  it('keeps a word active while another active source still has it', () => {
    // Removing a term from one card must not strip it from a preset or another category.
    const setWords = { code: ['Docker'] }
    const setActive = { code: true }
    const themeActive = { a: true, b: false }

    const fromTheme = removeThemeWord(themes, 'a', 'Docker')
    expect(composeHotwords([], setWords, setActive, fromTheme, themeActive)).toContain('Docker')

    const fromBoth = composeHotwords([], { code: [] }, setActive, fromTheme, themeActive)
    expect(fromBoth).not.toContain('Docker')
  })

  it('adds a suggested term to the chosen category', () => {
    expect(toggleThemeWord(themes, 'b', 'Kubernetes')[1].words).toEqual(['Docker', 'Kubernetes'])
  })

  it('treats a case-insensitive match as present and removes it', () => {
    expect(toggleThemeWord(themes, 'a', 'GitHub')[0].words).toEqual(['Docker'])
  })

  it('picks a free category name for a copy', () => {
    expect(uniqueThemeName(themes, 'Programming')).toBe('Programming')
    expect(uniqueThemeName(themes, 'mine')).toBe('mine (2)')
    expect(uniqueThemeName([...themes, { id: 'c', name: 'Mine (2)', words: [] }], 'Mine')).toBe('Mine (3)')
  })
})

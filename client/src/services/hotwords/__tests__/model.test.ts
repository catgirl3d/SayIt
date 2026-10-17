import { describe, expect, it } from 'vitest'
import { BUILTIN_SETS, legacyWordsToMigrate, normalizeBuiltinSetWords, withBuiltinSetDefaults } from '../model'

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

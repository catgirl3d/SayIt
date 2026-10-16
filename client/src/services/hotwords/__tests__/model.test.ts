import { describe, expect, it } from 'vitest'
import { BUILTIN_SETS, normalizeBuiltinSetWords } from '../model'

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

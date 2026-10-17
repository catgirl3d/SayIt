import { describe, expect, it } from 'vitest'
import {
  HOTWORD_TOKEN_BUDGET,
  builtinSetActivationFits,
  builtinSetCopyAllowed,
  customThemeActivationFits,
  estimateHotwordTokens,
  getBlockedBuiltinSets,
  getBlockedCustomThemes,
  termAdditionFits,
  type HotwordBudgetState,
} from '../budget'
import { composeHotwords, type CustomTheme } from '../model'

/**
 * Builds `count` distinct synthetic words of exactly `length` ASCII characters. The first
 * character is `seed`, so words from different seeds never collide. A 3-character word costs one
 * token and a 6-character word costs two under estimateHotwordTokens.
 */
function makeWords(seed: string, count: number, length: number): string[] {
  const words: string[] = []
  for (let i = 0; i < count; i++) {
    let rest = ''
    let n = i
    for (let k = 0; k < length - 1; k++) {
      rest += String.fromCharCode(97 + (n % 26))
      n = Math.floor(n / 26)
    }
    words.push(seed + rest)
  }
  return words
}

/** Builds a consistent manager state, computing the composed list the same way the hook does. */
function buildState(input: {
  builtin: Record<string, string[]>
  builtinActive: Record<string, boolean>
  themes?: CustomTheme[]
  themeActive?: Record<string, boolean>
  legacy?: string[]
}): HotwordBudgetState {
  const customThemes = input.themes ?? []
  const customThemeActive = input.themeActive ?? {}
  const hotwords = composeHotwords(
    input.legacy ?? [],
    input.builtin,
    input.builtinActive,
    customThemes,
    customThemeActive,
  )
  return {
    hotwords,
    builtinSetWords: input.builtin,
    builtinSetActive: input.builtinActive,
    customThemes,
    customThemeActive,
  }
}

describe('estimateHotwordTokens', () => {
  it('counts about three ASCII characters per token, at least one per term', () => {
    expect(estimateHotwordTokens(['Git', 'Kubernetes', 'C#'])).toBe(1 + 4 + 1)
  })

  it('weights non-ASCII terms more heavily', () => {
    expect(estimateHotwordTokens(['ребейз', 'коммит'])).toBe(3 + 3)
  })

  it('ignores blank terms', () => {
    expect(estimateHotwordTokens(['', '   ', 'npm'])).toBe(1)
  })
})

describe('builtinSetActivationFits', () => {
  it('allows switching on a set that keeps the projection within the budget', () => {
    const state = buildState({
      builtin: { a: makeWords('a', 10, 3) },
      builtinActive: { a: false },
    })
    expect(builtinSetActivationFits(state, 'a')).toBe(true)
  })

  it('refuses switching on a set whose projection exceeds the budget', () => {
    const state = buildState({
      builtin: { a: makeWords('a', HOTWORD_TOKEN_BUDGET + 1, 3) },
      builtinActive: { a: false },
    })
    expect(builtinSetActivationFits(state, 'a')).toBe(false)
  })

  it('refuses a set when custom words alone fill the budget', () => {
    const state = buildState({
      builtin: { a: makeWords('a', 1, 3) },
      builtinActive: { a: false },
      themes: [{ id: 't1', name: 'Mine', words: makeWords('c', HOTWORD_TOKEN_BUDGET, 3) }],
      themeActive: { t1: true },
    })
    expect(builtinSetActivationFits(state, 'a')).toBe(false)
  })

  it('allows a zero-cost set when custom words land exactly on the budget', () => {
    const custom = makeWords('c', HOTWORD_TOKEN_BUDGET, 3)
    const state = buildState({
      builtin: { a: custom.slice(0, 5) },
      builtinActive: { a: false },
      themes: [{ id: 't1', name: 'Mine', words: custom }],
      themeActive: { t1: true },
    })
    expect(builtinSetActivationFits(state, 'a')).toBe(true)
  })

  it('always allows switching off, even when the active list is over budget', () => {
    const state = buildState({
      builtin: { a: makeWords('a', HOTWORD_TOKEN_BUDGET + 50, 3) },
      builtinActive: { a: true },
    })
    expect(builtinSetActivationFits(state, 'a')).toBe(true)
  })

  it('counts a word shared by two sets once in the projection', () => {
    // 470 custom tokens + 20 active tokens = 490. The inactive set adds 10 new words, and its
    // other 20 words repeat the active set. Counting each occurrence would give 520 and wrongly refuse.
    const sharedWords = makeWords('a', 20, 3)
    const state = buildState({
      builtin: {
        a: sharedWords,
        b: [...sharedWords, ...makeWords('b', 10, 3)],
      },
      builtinActive: { a: true, b: false },
      themes: [{ id: 't1', name: 'Mine', words: makeWords('c', 470, 3) }],
      themeActive: { t1: true },
    })
    expect(builtinSetActivationFits(state, 'b')).toBe(true)
  })

  it('counts legacy words that belong to no source', () => {
    // 498 custom tokens + 2 tokens for the legacy term = 500. One more token from the set exceeds it.
    const state = buildState({
      builtin: { a: makeWords('a', 1, 3) },
      builtinActive: { a: false },
      themes: [{ id: 't1', name: 'Mine', words: makeWords('c', 498, 3) }],
      themeActive: { t1: true },
      legacy: ['zzzzzz'],
    })
    expect(builtinSetActivationFits(state, 'a')).toBe(false)
  })
})

describe('getBlockedBuiltinSets', () => {
  it('reports only inactive sets, marking those that would not fit', () => {
    const state = buildState({
      builtin: {
        small: makeWords('s', 5, 3),
        big: makeWords('g', HOTWORD_TOKEN_BUDGET + 1, 3),
        on: makeWords('o', 3, 3),
      },
      builtinActive: { small: false, big: false, on: true },
    })
    expect(getBlockedBuiltinSets(state, ['small', 'big', 'on'])).toEqual({
      small: false,
      big: true,
    })
  })
})

describe('termAdditionFits', () => {
  it('allows a new term while the estimate stays within the budget', () => {
    expect(termAdditionFits(true, new Set(['Git']), HOTWORD_TOKEN_BUDGET - 4, 'Kubernetes')).toBe(true)
  })

  it('refuses a new term that would exceed the budget', () => {
    expect(termAdditionFits(true, new Set(['Git']), HOTWORD_TOKEN_BUDGET - 3, 'Kubernetes')).toBe(false)
  })

  it('allows a term that is already active, because it costs nothing', () => {
    expect(termAdditionFits(true, new Set(['Kubernetes']), HOTWORD_TOKEN_BUDGET + 10, 'Kubernetes')).toBe(true)
  })

  it('allows any term in an inactive category, which adds nothing to the active list', () => {
    expect(termAdditionFits(false, new Set(['Git']), HOTWORD_TOKEN_BUDGET + 10, 'Kubernetes')).toBe(true)
  })
})

describe('builtinSetCopyAllowed', () => {
  it('allows copying a set that fits the budget', () => {
    const state = buildState({ builtin: { a: makeWords('a', 10, 3) }, builtinActive: { a: false } })
    expect(builtinSetCopyAllowed(state, 'a')).toBe(true)
  })

  it('refuses a set whose saved word list is empty, instead of creating an empty category', () => {
    const state = buildState({ builtin: { a: [] }, builtinActive: { a: true } })
    expect(builtinSetCopyAllowed(state, 'a')).toBe(false)
  })

  it('refuses a set that would not fit the budget', () => {
    const state = buildState({
      builtin: { a: makeWords('a', HOTWORD_TOKEN_BUDGET + 1, 3) },
      builtinActive: { a: false },
    })
    expect(builtinSetCopyAllowed(state, 'a')).toBe(false)
  })
})

describe('customThemeActivationFits', () => {
  it('allows switching on a category that keeps the projection within the budget', () => {
    const state = buildState({
      builtin: {},
      builtinActive: {},
      themes: [{ id: 't1', name: 'Mine', words: makeWords('c', 10, 3) }],
      themeActive: { t1: false },
    })
    expect(customThemeActivationFits(state, 't1')).toBe(true)
  })

  it('refuses switching on a category whose projection exceeds the budget', () => {
    // A copy of a built-in set is a custom category, so this gate keeps copies within the limit too.
    const state = buildState({
      builtin: { a: makeWords('a', HOTWORD_TOKEN_BUDGET - 5, 3) },
      builtinActive: { a: true },
      themes: [{ id: 't1', name: 'Copy', words: makeWords('c', 6, 3) }],
      themeActive: { t1: false },
    })
    expect(customThemeActivationFits(state, 't1')).toBe(false)
  })

  it('counts words shared with an active set once', () => {
    const shared = makeWords('a', HOTWORD_TOKEN_BUDGET, 3)
    const state = buildState({
      builtin: { a: shared },
      builtinActive: { a: true },
      themes: [{ id: 't1', name: 'Copy', words: shared.slice(0, 50) }],
      themeActive: { t1: false },
    })
    expect(customThemeActivationFits(state, 't1')).toBe(true)
  })

  it('always allows switching off, even when the active list is over budget', () => {
    const state = buildState({
      builtin: {},
      builtinActive: {},
      themes: [{ id: 't1', name: 'Mine', words: makeWords('c', HOTWORD_TOKEN_BUDGET + 50, 3) }],
      themeActive: { t1: true },
    })
    expect(customThemeActivationFits(state, 't1')).toBe(true)
  })
})

describe('getBlockedCustomThemes', () => {
  it('reports only inactive categories, marking those that would not fit', () => {
    const state = buildState({
      builtin: {},
      builtinActive: {},
      themes: [
        { id: 'small', name: 'Small', words: makeWords('s', 5, 3) },
        { id: 'big', name: 'Big', words: makeWords('g', HOTWORD_TOKEN_BUDGET + 1, 3) },
        { id: 'on', name: 'On', words: makeWords('o', 3, 3) },
      ],
      themeActive: { small: false, big: false, on: true },
    })
    expect(getBlockedCustomThemes(state)).toEqual({ small: false, big: true })
  })
})

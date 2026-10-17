import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_WORDS_KEY,
  BUILTIN_SETS,
  CUSTOM_THEME_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
} from '../model'

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
}))

vi.mock('@/services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => (key in mocks.settings ? mocks.settings[key] : fallback)),
}))

import { loadActiveHotwords } from '../settings'

describe('loadActiveHotwords', () => {
  beforeEach(() => {
    mocks.settings = {}
  })

  it('uses default words for an enabled built-in set that was never saved', async () => {
    // An install from before the code set existed has only the AI words in the store.
    mocks.settings = {
      [BUILTIN_SET_WORDS_KEY]: { ai: ['GPT'] },
      [BUILTIN_SET_ACTIVE_KEY]: { ai: true, code: true },
      [CUSTOM_THEMES_KEY]: [{ id: 'theme_a', name: 'Mine', words: ['SayIt fork'] }],
      [CUSTOM_THEME_ACTIVE_KEY]: { theme_a: true },
    }

    await expect(loadActiveHotwords()).resolves.toEqual([
      'GPT',
      ...BUILTIN_SETS.code.words,
      'SayIt fork',
    ])
  })

  it('leaves a disabled built-in set out', async () => {
    mocks.settings = {
      [BUILTIN_SET_WORDS_KEY]: { ai: ['GPT'] },
      [BUILTIN_SET_ACTIVE_KEY]: { ai: true, code: false },
    }

    await expect(loadActiveHotwords()).resolves.toEqual(['GPT'])
  })
})

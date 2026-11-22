import { useCallback, useEffect, useMemo, useReducer } from 'react'
import { setHotwordsCache } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import {
  BUILTIN_SETS,
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_EXTRA_WORDS_KEY,
  BUILTIN_SET_WORDS_KEY,
  CUSTOM_THEME_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
  LEGACY_MANUAL_WORDS_KEY,
  type CustomTheme,
  collectAllSourceWords,
  composeHotwords,
  createThemeId,
  filterBuiltinSetDefaultWords,
  legacyWordsToMigrate,
  normalizeBuiltinSetActive,
  normalizeCustomThemeActive,
  normalizeCustomThemes,
  parseWordsInput,
  removeThemeWord,
  resolveBuiltinSetWords,
  toggleThemeWord,
  uniqueThemeName,
  uniqueWords,
  withBuiltinSetActiveDefaults,
} from './model'
import {
  builtinSetActivationFits,
  builtinSetCopyAllowed,
  composeWithBuiltinSetToggled,
  composeWithCustomThemeToggled,
  customThemeActivationFits,
  estimateHotwordTokens,
  getBlockedBuiltinSets,
  getBlockedCustomThemes,
  termAdditionFits,
  type HotwordBudgetState,
} from './budget'
import { t } from '@/i18n'
import { hotwordsReducer, initialHotwordsState } from './stateMachine'

// Persist extras first so a failed second write cannot lose user words on the next load. Reversing
// the order could drop a new user word before the extras that record it reach the store.
async function persistBuiltinWords(
  wordsMap: Record<string, string[]>,
  extraWords: Record<string, string[]>,
) {
  await setSetting(BUILTIN_SET_EXTRA_WORDS_KEY, extraWords)
  await setSetting(BUILTIN_SET_WORDS_KEY, filterBuiltinSetDefaultWords(wordsMap))
}

// Prefix built-in categories in themeInputs so they cannot collide with custom theme ids.
export function builtinInputKey(setKey: string) {
  return `builtin:${setKey}`
}

export function useHotwordsManager() {
  const [state, dispatch] = useReducer(hotwordsReducer, initialHotwordsState)
  const {
    hotwords,
    builtinSetWords,
    builtinSetExtraWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
  } = state

  const setSnapshot = useCallback((payload: Partial<typeof state>) => {
    dispatch({ type: 'set_snapshot', payload })
  }, [])

  const persistBuiltinStates = useCallback(async (
    wordsMap: Record<string, string[]>,
    activeMap: Record<string, boolean>,
    extraWords: Record<string, string[]>,
  ) => {
    await Promise.all([
      persistBuiltinWords(wordsMap, extraWords),
      setSetting(BUILTIN_SET_ACTIVE_KEY, activeMap),
    ])
  }, [])

  const persistCustomThemeStates = useCallback(async (
    themes: CustomTheme[],
    activeMap: Record<string, boolean>,
  ) => {
    await Promise.all([
      setSetting(CUSTOM_THEMES_KEY, themes),
      setSetting(CUSTOM_THEME_ACTIVE_KEY, activeMap),
    ])
  }, [])

  const syncToBackend = useCallback(async (words: string[]) => {
    // Hotwords are no longer written to a global file on the backend. This only refreshes the
    // recorder's snapshot, and the next session delivers it with its start message.
    setHotwordsCache(words)
  }, [])

  const loadHotwords = useCallback(async () => {
    try {
      const [
        rawSetWords,
        rawSetExtraWords,
        rawSetActive,
        rawCustomThemes,
        rawCustomThemeActive,
        legacyManualWords,
      ] = await Promise.all([
        getSetting<Record<string, unknown>>(BUILTIN_SET_WORDS_KEY, {}),
        getSetting<Record<string, unknown>>(BUILTIN_SET_EXTRA_WORDS_KEY, {}),
        getSetting<Record<string, unknown>>(BUILTIN_SET_ACTIVE_KEY, {}),
        getSetting<unknown>(CUSTOM_THEMES_KEY, []),
        getSetting<Record<string, unknown>>(CUSTOM_THEME_ACTIVE_KEY, {}),
        getSetting<string[]>(LEGACY_MANUAL_WORDS_KEY, []),
      ])

      // All hotwords are loaded from the local store and do not depend on the remote server
      const {
        savedDefaultWords,
        extraWords: savedSetExtraWords,
        effectiveWords: nextSetWords,
      } = resolveBuiltinSetWords(rawSetWords, rawSetExtraWords)
      const savedSetActive = normalizeBuiltinSetActive(rawSetActive)
      const nextSetActive = withBuiltinSetActiveDefaults(savedSetActive)

      let nextCustomThemes = normalizeCustomThemes(rawCustomThemes)
      const migratedManualWords = legacyWordsToMigrate(legacyManualWords, nextSetWords, nextSetActive)

      if (nextCustomThemes.length === 0 && migratedManualWords.length > 0) {
        nextCustomThemes = [
          {
            id: createThemeId(),
            name: t('dict.myTheme'),
            words: migratedManualWords,
          },
        ]
      }

      const savedCustomThemeActive = normalizeCustomThemeActive(rawCustomThemeActive, nextCustomThemes)
      const nextCustomThemeActive: Record<string, boolean> = {}

      for (const theme of nextCustomThemes) {
        nextCustomThemeActive[theme.id] = typeof savedCustomThemeActive[theme.id] === 'boolean'
          ? savedCustomThemeActive[theme.id]
          : false
      }

      // Compose the currently active hotword list from the local state
      const composed = composeHotwords(
        [],
        nextSetWords,
        nextSetActive,
        nextCustomThemes,
        nextCustomThemeActive,
      )

      setSnapshot({
        hotwords: composed,
        builtinSetWords: nextSetWords,
        builtinSetExtraWords: savedSetExtraWords,
        builtinSetActive: nextSetActive,
        customThemes: nextCustomThemes,
        customThemeActive: nextCustomThemeActive,
      })
      setHotwordsCache(composed)

      const needPersistBuiltin = Object.keys(savedDefaultWords).length === 0 || Object.keys(savedSetActive).length === 0
      const needPersistCustom = normalizeCustomThemes(rawCustomThemes).length === 0
        || Object.keys(savedCustomThemeActive).length === 0
        || (nextCustomThemes.length > 0 && migratedManualWords.length > 0)

      if (needPersistBuiltin) {
        void persistBuiltinStates(nextSetWords, nextSetActive, savedSetExtraWords)
      }
      if (needPersistCustom) {
        void persistCustomThemeStates(nextCustomThemes, nextCustomThemeActive)
      }
      if (migratedManualWords.length > 0) {
        void setSetting(LEGACY_MANUAL_WORDS_KEY, [])
      }
    } catch {
      // backend unreachable
    } finally {
      dispatch({ type: 'set_loading', value: false })
    }
  }, [persistBuiltinStates, persistCustomThemeStates, setSnapshot])

  useEffect(() => {
    void loadHotwords()
  }, [loadHotwords])

  const budgetState = useMemo<HotwordBudgetState>(() => ({
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
  }), [builtinSetActive, builtinSetWords, customThemeActive, customThemes, hotwords])

  const addTheme = useCallback(async () => {
    const name = newThemeName.trim()
    if (!name) return

    const exists = customThemes.some((theme) => theme.name.toLowerCase() === name.toLowerCase())
    if (exists) {
      dispatch({ type: 'set_new_theme_name', value: '' })
      return
    }

    const nextTheme: CustomTheme = { id: createThemeId(), name, words: [] }
    const nextThemes = [nextTheme, ...customThemes]
    const nextActiveMap = { ...customThemeActive, [nextTheme.id]: true }

    setSnapshot({
      customThemes: nextThemes,
      customThemeActive: nextActiveMap,
      newThemeName: '',
      themeInputs: { ...themeInputs, [nextTheme.id]: '' },
    })

    await persistCustomThemeStates(nextThemes, nextActiveMap)
  }, [customThemeActive, customThemes, newThemeName, persistCustomThemeStates, setSnapshot, themeInputs])

  const applyAddedWords = useCallback(async (
    inputKey: string,
    currentWords: string[],
    build: (words: string[], addedWords: string[]) => {
      patch: Partial<typeof state>
      persist: () => Promise<unknown>
    },
  ) => {
    const raw = (themeInputs[inputKey] || '').trim()
    if (!raw) return

    const addedWords = parseWordsInput(raw).filter((word) => !currentWords.includes(word))
    if (addedWords.length === 0) {
      dispatch({ type: 'set_theme_input', themeId: inputKey, value: '' })
      return
    }

    const words = uniqueWords([...currentWords, ...addedWords])
    const { patch, persist } = build(words, addedWords)
    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((word) => !currentAllSourceWords.has(word))
    const updated = composeHotwords(
      preservedWords,
      patch.builtinSetWords ?? builtinSetWords,
      builtinSetActive,
      patch.customThemes ?? customThemes,
      customThemeActive,
    )

    setSnapshot({
      ...patch,
      hotwords: updated,
      themeInputs: { ...themeInputs, [inputKey]: '' },
    })

    await Promise.all([
      persist(),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    setSnapshot,
    syncToBackend,
    themeInputs,
  ])

  const addWordsToTheme = useCallback(async (themeId: string) => {
    const theme = customThemes.find((item) => item.id === themeId)
    if (!theme) return

    await applyAddedWords(themeId, theme.words, (words) => {
      const nextThemes = customThemes.map((item) => (
        item.id === themeId ? { ...item, words } : item
      ))
      return {
        patch: { customThemes: nextThemes },
        persist: () => persistCustomThemeStates(nextThemes, customThemeActive),
      }
    })
  }, [applyAddedWords, customThemeActive, customThemes])

  const addWordsToBuiltinSet = useCallback(async (setKey: string) => {
    if (!BUILTIN_SETS[setKey]) return

    await applyAddedWords(builtinInputKey(setKey), builtinSetWords[setKey] || [], (words, addedWords) => {
      const nextWordsMap = { ...builtinSetWords, [setKey]: words }
      const nextExtraWords = {
        ...builtinSetExtraWords,
        [setKey]: uniqueWords([...(builtinSetExtraWords[setKey] ?? []), ...addedWords]),
      }
      return {
        patch: { builtinSetWords: nextWordsMap, builtinSetExtraWords: nextExtraWords },
        persist: () => persistBuiltinWords(nextWordsMap, nextExtraWords),
      }
    })
  }, [applyAddedWords, builtinSetExtraWords, builtinSetWords])

  /**
   * Drag-and-drop reordering of custom hotword categories.
   * Order is not just cosmetic: the merged hotword list is truncated to MAX_HOTWORDS in order, and
   * some models consume only a small leading segment, so the categories higher up are the ones
   * that actually take effect.
   */
  const moveTheme = useCallback(async (from: number, to: number) => {
    if (from === to || from < 0 || to < 0 || from >= customThemes.length || to >= customThemes.length) return

    const nextThemes = [...customThemes]
    const [moved] = nextThemes.splice(from, 1)
    nextThemes.splice(to, 0, moved)

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      builtinSetActive,
      nextThemes,
      customThemeActive,
    )

    setSnapshot({ customThemes: nextThemes, hotwords: updated })

    await Promise.all([
      persistCustomThemeStates(nextThemes, customThemeActive),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    persistCustomThemeStates,
    setSnapshot,
    syncToBackend,
  ])

  const removeTheme = useCallback(async (themeId: string) => {
    const nextThemes = customThemes.filter((item) => item.id !== themeId)
    const nextActiveMap = { ...customThemeActive }
    delete nextActiveMap[themeId]

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      builtinSetActive,
      nextThemes,
      nextActiveMap,
    )

    const nextInputs = { ...themeInputs }
    delete nextInputs[themeId]

    setSnapshot({
      customThemes: nextThemes,
      customThemeActive: nextActiveMap,
      hotwords: updated,
      themeInputs: nextInputs,
    })

    await Promise.all([
      persistCustomThemeStates(nextThemes, nextActiveMap),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    persistCustomThemeStates,
    setSnapshot,
    syncToBackend,
    themeInputs,
  ])

  const toggleCustomTheme = useCallback(async (themeId: string) => {
    // Switching a category ON is refused when it would exceed the token budget, even if the UI did
    // not disable the control. Switching OFF is never refused.
    if (!customThemeActivationFits(budgetState, themeId)) return

    const nextActiveMap = {
      ...customThemeActive,
      [themeId]: !customThemeActive[themeId],
    }
    const updated = composeWithCustomThemeToggled(budgetState, themeId)

    setSnapshot({
      customThemeActive: nextActiveMap,
      hotwords: updated,
    })

    await Promise.all([
      setSetting(CUSTOM_THEME_ACTIVE_KEY, nextActiveMap),
      syncToBackend(updated),
    ])
  }, [budgetState, customThemeActive, setSnapshot, syncToBackend])

  /**
   * Removes a word from one custom category only. The word stays active when another active
   * category or built-in set still has it.
   */
  const removeWordFromTheme = useCallback(async (themeId: string, word: string) => {
    const nextThemes = removeThemeWord(customThemes, themeId, word)
    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      builtinSetActive,
      nextThemes,
      customThemeActive,
    )

    setSnapshot({ customThemes: nextThemes, hotwords: updated })

    await Promise.all([
      setSetting(CUSTOM_THEMES_KEY, nextThemes),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    setSnapshot,
    syncToBackend,
  ])

  /** Removes a word from one built-in set only; Reset brings it back. */
  const removeWordFromBuiltinSet = useCallback(async (key: string, word: string) => {
    const nextSetWords = {
      ...builtinSetWords,
      [key]: (builtinSetWords[key] || []).filter((w) => w !== word),
    }
    const nextExtraWords = { ...builtinSetExtraWords }
    const remainingExtras = (nextExtraWords[key] ?? []).filter((w) => w !== word)
    if (remainingExtras.length > 0) nextExtraWords[key] = remainingExtras
    else delete nextExtraWords[key]

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      nextSetWords,
      builtinSetActive,
      customThemes,
      customThemeActive,
    )

    setSnapshot({
      builtinSetWords: nextSetWords,
      builtinSetExtraWords: nextExtraWords,
      hotwords: updated,
    })

    await Promise.all([
      persistBuiltinWords(nextSetWords, nextExtraWords),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetExtraWords,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    setSnapshot,
    syncToBackend,
  ])

  /** Removes a legacy word that belongs to no built-in set or custom category. */
  const removeLegacyWord = useCallback(async (word: string) => {
    const updated = hotwords.filter((w) => w !== word)
    setSnapshot({ hotwords: updated })
    await syncToBackend(updated)
  }, [hotwords, setSnapshot, syncToBackend])

  const toggleBuiltinSet = useCallback(async (key: string) => {
    // Switching a set ON is refused when the list it would produce exceeds the token budget,
    // even if the UI did not disable the control. Switching OFF is never refused.
    if (!builtinSetActivationFits(budgetState, key)) return

    const nextActiveMap = { ...builtinSetActive, [key]: !builtinSetActive[key] }
    const updated = composeWithBuiltinSetToggled(budgetState, key)

    setSnapshot({
      builtinSetActive: nextActiveMap,
      hotwords: updated,
    })

    await Promise.all([
      setSetting(BUILTIN_SET_ACTIVE_KEY, nextActiveMap),
      syncToBackend(updated),
    ])
  }, [budgetState, builtinSetActive, setSnapshot, syncToBackend])

  const resetBuiltinSet = useCallback(async (key: string) => {
    const setDef = BUILTIN_SETS[key]
    if (!setDef) return

    const defaults = uniqueWords(setDef.words)
    const nextWordsMap = { ...builtinSetWords, [key]: defaults }
    const nextExtraWords = { ...builtinSetExtraWords }
    delete nextExtraWords[key]

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      nextWordsMap,
      builtinSetActive,
      customThemes,
      customThemeActive,
    )

    setSnapshot({
      builtinSetWords: nextWordsMap,
      builtinSetExtraWords: nextExtraWords,
      hotwords: updated,
    })

    await Promise.all([
      persistBuiltinWords(nextWordsMap, nextExtraWords),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetExtraWords,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    setSnapshot,
    syncToBackend,
  ])

  /**
   * Copies a built-in set into a new, active custom category so its terms can be curated one by
   * one. The copy takes over from the set: an active set is switched off, otherwise removing a term
   * from the copy would leave it active through the set. A copy holds exactly the set's current
   * words, so it is refused when the set is empty or switching it on would not fit the budget.
   */
  const copyBuiltinSetToTheme = useCallback(async (key: string) => {
    const setDef = BUILTIN_SETS[key]
    if (!setDef || !builtinSetCopyAllowed(budgetState, key)) return

    const nextTheme: CustomTheme = {
      id: createThemeId(),
      name: uniqueThemeName(customThemes, setDef.label),
      words: builtinSetWords[key],
    }
    const nextThemes = [nextTheme, ...customThemes]
    const nextThemeActive = { ...customThemeActive, [nextTheme.id]: true }
    const nextSetActive = { ...builtinSetActive, [key]: false }

    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      nextSetActive,
      nextThemes,
      nextThemeActive,
    )

    setSnapshot({
      customThemes: nextThemes,
      customThemeActive: nextThemeActive,
      builtinSetActive: nextSetActive,
      hotwords: updated,
      themeInputs: { ...themeInputs, [nextTheme.id]: '' },
    })

    await Promise.all([
      persistCustomThemeStates(nextThemes, nextThemeActive),
      setSetting(BUILTIN_SET_ACTIVE_KEY, nextSetActive),
      syncToBackend(updated),
    ])
  }, [
    budgetState,
    builtinSetActive,
    builtinSetWords,
    customThemeActive,
    customThemes,
    hotwords,
    persistCustomThemeStates,
    setSnapshot,
    syncToBackend,
    themeInputs,
  ])

  const hotwordSet = useMemo(() => new Set(hotwords), [hotwords])
  const hotwordTokens = useMemo(() => estimateHotwordTokens(hotwords), [hotwords])
  const builtinSetBlocked = useMemo(
    () => getBlockedBuiltinSets(budgetState, Object.keys(BUILTIN_SETS)),
    [budgetState],
  )
  const customThemeBlocked = useMemo(() => getBlockedCustomThemes(budgetState), [budgetState])
  const builtinSetCopyable = useMemo(() => {
    const copyable: Record<string, boolean> = {}
    for (const key of Object.keys(BUILTIN_SETS)) copyable[key] = builtinSetCopyAllowed(budgetState, key)
    return copyable
  }, [budgetState])

  /** Whether a suggested term can still be added to the category under the token budget. */
  const canAddSuggestedTerm = useCallback(
    (themeId: string, word: string) => termAdditionFits(!!customThemeActive[themeId], hotwordSet, hotwordTokens, word),
    [customThemeActive, hotwordSet, hotwordTokens],
  )

  /**
   * Adds a suggested term to a custom category, or removes it when the category already has it.
   * Adding to an active category is refused when it would exceed the token budget, even if the UI
   * did not disable the term; terms typed by hand are never refused.
   */
  const toggleSuggestedTerm = useCallback(async (themeId: string, word: string) => {
    const theme = customThemes.find((item) => item.id === themeId)
    if (!theme) return

    const lower = word.toLowerCase()
    const adding = !theme.words.some((w) => w.toLowerCase() === lower)
    if (adding && !canAddSuggestedTerm(themeId, word)) return

    const nextThemes = toggleThemeWord(customThemes, themeId, word)
    const currentAllSourceWords = collectAllSourceWords(builtinSetWords, customThemes)
    const preservedWords = hotwords.filter((w) => !currentAllSourceWords.has(w))
    const updated = composeHotwords(
      preservedWords,
      builtinSetWords,
      builtinSetActive,
      nextThemes,
      customThemeActive,
    )

    setSnapshot({ customThemes: nextThemes, hotwords: updated })

    await Promise.all([
      setSetting(CUSTOM_THEMES_KEY, nextThemes),
      syncToBackend(updated),
    ])
  }, [
    builtinSetActive,
    builtinSetWords,
    canAddSuggestedTerm,
    customThemeActive,
    customThemes,
    hotwords,
    setSnapshot,
    syncToBackend,
  ])
  const allKnownWords = useMemo(() => collectAllSourceWords(builtinSetWords, customThemes), [builtinSetWords, customThemes])
  const unknownWords = useMemo(
    () => hotwords.filter((word) => !allKnownWords.has(word)),
    [allKnownWords, hotwords],
  )

  const filtered = search
    ? hotwords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
    : hotwords

  const filteredUnknown = search
    ? unknownWords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
    : unknownWords

  const getSetWordsInHotwords = useCallback((key: string) => {
    const setWords = builtinSetWords[key] || []
    const activeWords = setWords.filter((w) => hotwordSet.has(w))
    if (!search) return activeWords
    return activeWords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
  }, [builtinSetWords, hotwordSet, search])

  const getThemeWordsInHotwords = useCallback((theme: CustomTheme) => {
    const activeWords = theme.words.filter((w) => hotwordSet.has(w))
    if (!search) return activeWords
    return activeWords.filter((w) => w.toLowerCase().includes(search.toLowerCase()))
  }, [hotwordSet, search])

  const visibleCustomThemes = customThemes.filter((theme) => {
    if (!search) return true
    const activeWords = getThemeWordsInHotwords(theme)
    return activeWords.length > 0 || theme.name.toLowerCase().includes(search.toLowerCase())
  })

  return {
    hotwords,
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    themeInputs,
    newThemeName,
    search,
    loading,
    showUnknown,
    hotwordTokens,
    builtinSetBlocked,
    customThemeBlocked,
    builtinSetCopyable,
    filtered,
    filteredUnknown,
    visibleCustomThemes,
    getSetWordsInHotwords,
    getThemeWordsInHotwords,
    setNewThemeName: (value: string) => dispatch({ type: 'set_new_theme_name', value }),
    setSearch: (value: string) => dispatch({ type: 'set_search', value }),
    setShowUnknown: (value: boolean) => dispatch({ type: 'set_show_unknown', value }),
    setThemeInput: (themeId: string, value: string) => dispatch({ type: 'set_theme_input', themeId, value }),
    addTheme,
    addWordsToTheme,
    addWordsToBuiltinSet,
    removeTheme,
    moveTheme,
    toggleCustomTheme,
    removeWordFromTheme,
    removeWordFromBuiltinSet,
    removeLegacyWord,
    canAddSuggestedTerm,
    toggleSuggestedTerm,
    toggleBuiltinSet,
    resetBuiltinSet,
    copyBuiltinSetToTheme,
  }
}

import { getSetting } from '../store'
import {
  BUILTIN_SET_ACTIVE_KEY,
  BUILTIN_SET_WORDS_KEY,
  CUSTOM_THEME_ACTIVE_KEY,
  CUSTOM_THEMES_KEY,
  composeHotwords,
  normalizeBuiltinSetActive,
  normalizeBuiltinSetWords,
  normalizeCustomThemeActive,
  normalizeCustomThemes,
  withBuiltinSetDefaults,
} from './model'

/** Canonical active hotword list shared by dictation, re-recognition, and subtitle sessions. */
export async function loadActiveHotwords(): Promise<string[]> {
  const [rawSetWords, rawSetActive, rawCustomThemes, rawCustomThemeActive] = await Promise.all([
    getSetting(BUILTIN_SET_WORDS_KEY, {}),
    getSetting(BUILTIN_SET_ACTIVE_KEY, {}),
    getSetting(CUSTOM_THEMES_KEY, []),
    getSetting(CUSTOM_THEME_ACTIVE_KEY, {}),
  ])
  const setWords = withBuiltinSetDefaults(normalizeBuiltinSetWords(rawSetWords as Record<string, unknown>))
  const setActive = normalizeBuiltinSetActive(rawSetActive as Record<string, unknown>)
  const themes = normalizeCustomThemes(rawCustomThemes)
  const themeActive = normalizeCustomThemeActive(rawCustomThemeActive as Record<string, unknown>, themes)
  return composeHotwords([], setWords, setActive, themes, themeActive)
}

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
  type CustomTheme,
} from './model'

export interface HotwordCatalog {
  builtinSetWords: Record<string, string[]>
  builtinSetActive: Record<string, boolean>
  customThemes: CustomTheme[]
  customThemeActive: Record<string, boolean>
  activeWords: string[]
}

/**
 * Canonical active hotword list shared by dictation, re-recognition, and subtitle sessions.
 *
 * This loader deliberately does not seed the `ai` set as active and does not migrate legacy
 * `manualHotwords`; both are hydration rules of the dictionary manager (`useHotwordsManager`),
 * which persists the seeded state when the dictionary page runs. Until that happens, these
 * read-only sessions see exactly the active flags already saved in the store.
 */
export async function loadActiveHotwords(): Promise<string[]> {
  return (await loadHotwordCatalog()).activeWords
}

/**
 * Loads the category catalog and the active list from one settings snapshot. The Files page uses
 * the catalog to offer a per-job category selection composed by the same rules as dictation.
 */
export async function loadHotwordCatalog(): Promise<HotwordCatalog> {
  const [rawSetWords, rawSetActive, rawCustomThemes, rawCustomThemeActive] = await Promise.all([
    getSetting(BUILTIN_SET_WORDS_KEY, {}),
    getSetting(BUILTIN_SET_ACTIVE_KEY, {}),
    getSetting(CUSTOM_THEMES_KEY, []),
    getSetting(CUSTOM_THEME_ACTIVE_KEY, {}),
  ])
  const builtinSetWords = withBuiltinSetDefaults(normalizeBuiltinSetWords(rawSetWords as Record<string, unknown>))
  const builtinSetActive = normalizeBuiltinSetActive(rawSetActive as Record<string, unknown>)
  const customThemes = normalizeCustomThemes(rawCustomThemes)
  const customThemeActive = normalizeCustomThemeActive(rawCustomThemeActive as Record<string, unknown>, customThemes)
  return {
    builtinSetWords,
    builtinSetActive,
    customThemes,
    customThemeActive,
    activeWords: composeHotwords([], builtinSetWords, builtinSetActive, customThemes, customThemeActive),
  }
}

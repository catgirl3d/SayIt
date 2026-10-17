/**
 * Theme registry and switching logic.
 *
 * Usage:
 *   import { applyTheme, getTheme, themeList } from '@/themes'
 *   applyTheme('dark')
 */
import type { ThemeDefinition, ThemeId } from './types'
import light from './light'
import dark from './dark'
import claude from './claude'
import teal from './teal'
import tealDark from './teal-dark'
import orchid from './orchid'
import twilight from './twilight'
import espresso from './espresso'
import frost from './frost'
import moss from './moss'
import midnight from './midnight'

/**
 * All registered themes (adding a theme only takes one line here).
 * Insertion order is display order: the theme picker lists the themes of each
 * brightness group in this order.
 */
const themes: Record<string, ThemeDefinition> = {
  light,
  dark,
  claude,
  teal,
  'teal-dark': tealDark,
  orchid,
  twilight,
  espresso,
  frost,
  moss,
  midnight,
}

/** Theme list (used for UI rendering) */
export const themeList: ThemeDefinition[] = Object.values(themes)

/** Look up a theme definition; falls back to light when the ID is unknown */
export function getTheme(id: string): ThemeDefinition {
  return themes[id] || themes.light
}

/** ID of the currently applied theme */
let currentThemeId: string = 'light'

/** Get the ID of the currently applied theme */
export function getCurrentThemeId(): string {
  return currentThemeId
}

/** Default font (matches the body rule in index.css) */
const DEFAULT_FONT_BODY = '"Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Microsoft YaHei", sans-serif'

/**
 * Apply a theme: inject the CSS variables into :root, toggle the dark class and set the font.
 * @returns the ID of the theme that was actually applied
 */
export function applyTheme(id: string): string {
  const theme = getTheme(id)
  const root = document.documentElement

  // Inject the global variables
  const allVars = { ...theme.vars, ...(theme.extras || {}) }
  for (const [key, value] of Object.entries(allVars)) {
    root.style.setProperty(key, value)
  }

  // Switch the font
  document.body.style.fontFamily = theme.fonts?.body || DEFAULT_FONT_BODY

  // Toggle the dark class (Tailwind dark: prefix)
  if (theme.isDark) {
    root.classList.add('dark')
  } else {
    root.classList.remove('dark')
  }

  // Toggle the theme marker class (for theme-specific CSS)
  for (const t of themeList) {
    root.classList.remove(`theme-${t.id}`)
  }
  root.classList.add(`theme-${theme.id}`)

  currentThemeId = theme.id
  return theme.id
}

export type { ThemeDefinition, ThemeId }

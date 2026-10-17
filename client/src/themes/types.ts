/** Type definitions for the theme system */

/** Global semantic CSS variables - every theme must provide them */
export interface ThemeVars {
  // Base colours
  '--background': string
  '--foreground': string
  '--card': string
  '--card-foreground': string
  // Floating surfaces (tooltips, dropdowns, popovers). In dark themes this must
  // stay darker than both --card and --background: shadows are nearly invisible
  // there, so the fill difference is what separates a panel from what it covers.
  '--popover': string
  '--primary': string
  '--primary-foreground': string
  '--secondary': string
  '--secondary-foreground': string
  '--muted': string
  '--muted-foreground': string
  '--accent': string
  '--accent-foreground': string
  '--destructive': string
  '--destructive-foreground': string
  '--border': string
  '--input': string
  '--ring': string
  '--radius': string

  // Region colours
  '--sidebar-bg': string
  '--sidebar-border': string
  '--sidebar-item-active-bg': string
  '--sidebar-item-hover-bg': string
  '--sidebar-text': string
  '--sidebar-text-active': string
  '--titlebar-bg': string
  '--titlebar-text': string
  '--titlebar-close-hover-bg': string
  '--titlebar-close-hover-text': string

  // Form controls
  '--input-bg': string
  '--input-border': string
  '--input-focus-border': string
  '--input-focus-ring': string
  '--input-placeholder': string

  // Status colours
  //
  // Each status has three variables with different purposes - do not mix them up:
  //   --xxx              the colour block itself (dots, progress-bar fill, 10% tinted background)
  //   --xxx-foreground   text drawn on top of the colour block
  //   --xxx-strong       the colour of **text** drawn directly on the page/card background
  //
  // Why -strong exists: mid-lightness colours such as --success/--warning/--info reach only
  // 2-3.3:1 contrast on the white background of light themes, far below the 4.5:1
  // requirement for body text (the `text-warning` "model not downloaded yet" line used to be
  // the least readable line on the whole card). -strong is the same hue darkened or lightened
  // until it passes, and is used only for text and outlines.
  '--success': string
  '--success-foreground': string
  '--success-strong': string
  '--warning': string
  '--warning-foreground': string
  '--warning-strong': string
  '--info': string
  '--info-foreground': string
  '--info-strong': string
  '--destructive-strong': string
}

/** Theme extension variables - variables unique to one theme (optional) */
export type ThemeExtras = Record<string, string>

/** Theme font configuration (optional) */
export interface ThemeFonts {
  /** Body text font */
  body?: string
  /** Monospace font */
  mono?: string
}

/** Theme definition */
export interface ThemeDefinition {
  /** Unique identifier */
  id: string
  /** Display name */
  name: string
  /** Whether this is a dark theme (controls the Tailwind dark: prefix) */
  isDark: boolean
  /** Preview colours (used by the theme picker on the settings page) */
  previewColors: {
    bg: string
    sidebar: string
    primary: string
    accent: string
  }
  /** Global CSS variables */
  vars: ThemeVars
  /** Variables unique to this theme */
  extras?: ThemeExtras
  /** Theme fonts (the global default font is used when unset) */
  fonts?: ThemeFonts
}

/** Theme ID type */
export type ThemeId =
  | 'light'
  | 'dark'
  | 'claude'
  | 'teal'
  | 'teal-dark'
  | 'orchid'
  | 'twilight'
  | 'espresso'
  | 'frost'
  | 'moss'
  | 'midnight'

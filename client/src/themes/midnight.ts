import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

/**
 * Midnight - near-black dark theme for OLED screens.
 * Cool-neutral surfaces close to true black and a single vivid cobalt accent.
 * The page background stays around 4% lightness instead of 0%: popovers must
 * remain darker than both the card and the page (see popoverSurface.test.ts),
 * so the background needs headroom above pure black. Info is cyan so it does not
 * blend into the blue accent.
 */
const midnight: ThemeDefinition = {
  id: 'midnight',
  get name() { return t('theme.midnight') },
  isDark: true,
  previewColors: {
    bg: '#090a0b',
    sidebar: '#070709',
    primary: '#5692fb',
    accent: '#202227',
  },
  vars: {
    // Base colours - cool near-black
    '--background': '225 10% 4%',
    '--foreground': '220 14% 90%',
    '--card': '225 10% 7%',
    '--card-foreground': '220 14% 90%',
    // Floating panels: darker than the card and the page background, same
    // rationale as the dark theme.
    '--popover': '225 12% 2.5%',
    '--primary': '218 95% 66%',
    '--primary-foreground': '225 40% 6%',
    '--secondary': '225 8% 11%',
    '--secondary-foreground': '220 14% 88%',
    '--muted': '225 8% 11%',
    '--muted-foreground': '220 8% 64%',
    '--accent': '225 10% 14%',
    '--accent-foreground': '220 14% 90%',
    '--destructive': '0 65% 50%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '0 85% 70%',
    '--border': '225 8% 17%',
    '--input': '225 8% 17%',
    '--ring': '218 95% 66%',
    '--radius': '0.5rem',

    // Regions
    '--sidebar-bg': '225 12% 3%',
    '--sidebar-border': '225 8% 11%',
    '--sidebar-item-active-bg': '225 12% 10%',
    '--sidebar-item-hover-bg': '225 10% 7.5%',
    '--sidebar-text': '220 8% 62%',
    '--sidebar-text-active': '218 95% 72%',
    '--titlebar-bg': '225 12% 3%',
    '--titlebar-text': '220 8% 64%',
    '--titlebar-close-hover-bg': '0 65% 50%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // Form controls
    '--input-bg': '225 10% 5.5%',
    '--input-border': '225 8% 20%',
    '--input-focus-border': '218 95% 66%',
    '--input-focus-ring': '218 95% 66%',
    '--input-placeholder': '220 6% 46%',

    // Status colours (dark surface: -strong is lifted a little, see types.ts).
    // The fills are light enough to carry dark text, so the -foreground values are dark.
    '--success': '150 50% 52%',
    '--success-foreground': '150 50% 6%',
    '--success-strong': '150 55% 62%',
    '--warning': '40 90% 58%',
    '--warning-foreground': '40 60% 8%',
    '--warning-strong': '40 95% 66%',
    '--info': '188 85% 52%',
    '--info-foreground': '195 70% 6%',
    '--info-strong': '188 85% 62%',
  },
}

export default midnight

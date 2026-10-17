import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

/**
 * Twilight - deep indigo-violet dark theme.
 * Blue-violet tinted near-black surfaces with a soft lilac accent. The accent hue
 * (258) stays clear of every status colour (green, amber, blue, red), so primary
 * actions are never confused with warnings, info or destructive buttons.
 */
const twilight: ThemeDefinition = {
  id: 'twilight',
  get name() { return t('theme.twilight') },
  isDark: true,
  previewColors: {
    bg: '#191821',
    sidebar: '#13111a',
    primary: '#a684f5',
    accent: '#332f41',
  },
  vars: {
    // Base colours - violet-tinted near-black
    '--background': '250 16% 11%',
    '--foreground': '250 20% 91%',
    '--card': '250 14% 14%',
    '--card-foreground': '250 20% 91%',
    // Floating panels: darker than the card and the page background, same
    // rationale as the dark theme.
    '--popover': '250 18% 8%',
    '--primary': '258 85% 74%',
    '--primary-foreground': '252 35% 10%',
    '--secondary': '250 12% 18%',
    '--secondary-foreground': '250 15% 88%',
    '--muted': '250 12% 18%',
    '--muted-foreground': '250 10% 66%',
    '--accent': '252 16% 22%',
    '--accent-foreground': '250 20% 91%',
    '--destructive': '352 62% 48%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '352 85% 72%',
    '--border': '250 10% 22%',
    '--input': '250 10% 22%',
    '--ring': '258 85% 74%',
    '--radius': '0.5rem',

    // Regions
    '--sidebar-bg': '250 20% 8.5%',
    '--sidebar-border': '250 12% 16%',
    '--sidebar-item-active-bg': '252 20% 17%',
    '--sidebar-item-hover-bg': '250 14% 14%',
    '--sidebar-text': '250 10% 66%',
    '--sidebar-text-active': '258 85% 78%',
    '--titlebar-bg': '250 20% 8.5%',
    '--titlebar-text': '250 10% 66%',
    '--titlebar-close-hover-bg': '352 62% 48%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // Form controls
    '--input-bg': '250 16% 12.5%',
    '--input-border': '250 10% 24%',
    '--input-focus-border': '258 85% 74%',
    '--input-focus-ring': '258 85% 74%',
    '--input-placeholder': '250 8% 50%',

    // Status colours (dark surface: -strong is lifted a little, see types.ts).
    // The fills are light enough to carry dark text, so the -foreground values are dark.
    '--success': '150 45% 52%',
    '--success-foreground': '150 50% 8%',
    '--success-strong': '150 50% 64%',
    '--warning': '40 85% 60%',
    '--warning-foreground': '40 60% 8%',
    '--warning-strong': '40 90% 68%',
    '--info': '205 75% 60%',
    '--info-foreground': '210 60% 8%',
    '--info-strong': '205 85% 70%',
  },
}

export default twilight

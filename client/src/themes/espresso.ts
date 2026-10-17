import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

/**
 * Espresso - warm brown-black dark theme.
 * Roasted-coffee surfaces, cream text and a copper accent. Copper (hue 24) sits
 * close to amber, so the warning colours are pushed toward lemon yellow (hue 50)
 * to keep warnings distinguishable from primary actions.
 */
const espresso: ThemeDefinition = {
  id: 'espresso',
  get name() { return t('theme.espresso') },
  isDark: true,
  previewColors: {
    bg: '#1d1916',
    sidebar: '#181411',
    primary: '#e18447',
    accent: '#3d342e',
  },
  vars: {
    // Base colours - brown-tinted near-black with cream text
    '--background': '22 14% 10%',
    '--foreground': '30 25% 90%',
    '--card': '22 12% 13%',
    '--card-foreground': '30 25% 90%',
    // Floating panels: darker than the card and the page background, same
    // rationale as the dark theme.
    '--popover': '22 16% 7.5%',
    '--primary': '24 72% 58%',
    '--primary-foreground': '22 40% 8%',
    '--secondary': '22 10% 17%',
    '--secondary-foreground': '30 20% 87%',
    '--muted': '22 10% 17%',
    '--muted-foreground': '28 12% 64%',
    '--accent': '24 14% 21%',
    '--accent-foreground': '30 25% 90%',
    '--destructive': '2 62% 48%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '2 85% 70%',
    '--border': '22 10% 21%',
    '--input': '22 10% 21%',
    '--ring': '24 72% 58%',
    '--radius': '0.5rem',

    // Regions
    '--sidebar-bg': '22 16% 8%',
    '--sidebar-border': '22 10% 15%',
    '--sidebar-item-active-bg': '24 16% 16%',
    '--sidebar-item-hover-bg': '22 12% 13%',
    '--sidebar-text': '28 12% 64%',
    '--sidebar-text-active': '24 72% 64%',
    '--titlebar-bg': '22 16% 8%',
    '--titlebar-text': '28 12% 64%',
    '--titlebar-close-hover-bg': '2 62% 48%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // Form controls
    '--input-bg': '22 14% 11.5%',
    '--input-border': '22 10% 23%',
    '--input-focus-border': '24 72% 58%',
    '--input-focus-ring': '24 72% 58%',
    '--input-placeholder': '26 8% 50%',

    // Status colours (dark surface: -strong is lifted a little, see types.ts).
    // The fills are light enough to carry dark text, so the -foreground values are dark.
    '--success': '145 40% 50%',
    '--success-foreground': '145 50% 8%',
    '--success-strong': '145 45% 62%',
    '--warning': '50 85% 58%',
    '--warning-foreground': '48 60% 8%',
    '--warning-strong': '50 90% 66%',
    '--info': '200 65% 58%',
    '--info-foreground': '205 60% 8%',
    '--info-strong': '200 75% 68%',
  },
}

export default espresso

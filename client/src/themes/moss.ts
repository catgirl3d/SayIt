import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

/**
 * Moss - muted sage-green light theme.
 * Pale green-grey surfaces with a deep olive accent, easy on the eyes for long
 * sessions. The accent is a yellow-green (hue 88) and success is shifted to a
 * teal-green (165), so primary actions and success states do not read as the
 * same colour.
 */
const moss: ThemeDefinition = {
  id: 'moss',
  get name() { return t('theme.moss') },
  isDark: false,
  previewColors: {
    bg: '#f2f5f0',
    sidebar: '#e5e9e2',
    primary: '#476624',
    accent: '#e3e9dd',
  },
  vars: {
    // Base colours - pale sage with deep green-black text
    '--background': '90 20% 95%',
    '--foreground': '100 18% 14%',
    '--card': '90 28% 98%',
    '--card-foreground': '100 18% 14%',
    // Floating panels keep the card tone: in light themes the shadow separates them.
    '--popover': '90 28% 98%',
    '--primary': '88 48% 27%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '92 14% 90%',
    '--secondary-foreground': '100 18% 14%',
    '--muted': '92 14% 90%',
    '--muted-foreground': '95 10% 36%',
    '--accent': '92 22% 89%',
    '--accent-foreground': '100 18% 14%',
    '--destructive': '0 72% 49%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '0 74% 40%',
    '--border': '90 14% 82%',
    '--input': '90 14% 82%',
    '--ring': '88 48% 27%',
    '--radius': '0.5rem',

    // Regions
    '--sidebar-bg': '92 14% 90%',
    '--sidebar-border': '90 14% 82%',
    '--sidebar-item-active-bg': '90 22% 84%',
    '--sidebar-item-hover-bg': '92 14% 87%',
    '--sidebar-text': '95 10% 33%',
    '--sidebar-text-active': '88 48% 24%',
    '--titlebar-bg': '92 14% 90%',
    '--titlebar-text': '95 10% 33%',
    '--titlebar-close-hover-bg': '0 72% 49%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // Form controls
    '--input-bg': '90 28% 98%',
    '--input-border': '90 14% 78%',
    '--input-focus-border': '88 48% 27%',
    '--input-focus-ring': '88 48% 27%',
    '--input-placeholder': '95 6% 44%',

    // Status colours (light surface: -strong is the text colour that meets contrast, see types.ts).
    // The amber fill is too light for white text, so the warning -foreground is dark.
    '--success': '165 62% 30%',
    '--success-foreground': '0 0% 100%',
    '--success-strong': '165 65% 21%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '30 80% 10%',
    '--warning-strong': '28 90% 29%',
    '--info': '205 80% 40%',
    '--info-foreground': '0 0% 100%',
    '--info-strong': '205 85% 28%',
  },
}

export default moss

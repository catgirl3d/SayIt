import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

/**
 * Frost - cool blue-grey light theme.
 * Icy slate surfaces with a clear cobalt-blue accent. The accent (hue 218) stays
 * well away from the teal themes (182), and info is shifted to cyan (190) so
 * informational text is not mistaken for a primary action.
 */
const frost: ThemeDefinition = {
  id: 'frost',
  get name() { return t('theme.frost') },
  isDark: false,
  previewColors: {
    bg: '#f5f7fa',
    sidebar: '#e9edf2',
    primary: '#225bbf',
    accent: '#e3eaf2',
  },
  vars: {
    // Base colours - icy blue-grey with slate text
    '--background': '214 30% 97%',
    '--foreground': '218 28% 14%',
    '--card': '210 40% 99%',
    '--card-foreground': '218 28% 14%',
    // Floating panels keep the card tone: in light themes the shadow separates them.
    '--popover': '210 40% 99%',
    '--primary': '218 70% 44%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '214 24% 93%',
    '--secondary-foreground': '218 28% 14%',
    '--muted': '214 24% 93%',
    '--muted-foreground': '216 14% 38%',
    '--accent': '212 36% 92%',
    '--accent-foreground': '218 28% 14%',
    '--destructive': '0 72% 49%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '0 74% 40%',
    '--border': '214 22% 86%',
    '--input': '214 22% 86%',
    '--ring': '218 70% 44%',
    '--radius': '0.5rem',

    // Regions
    '--sidebar-bg': '214 26% 93%',
    '--sidebar-border': '214 22% 86%',
    '--sidebar-item-active-bg': '212 40% 88%',
    '--sidebar-item-hover-bg': '214 26% 90%',
    '--sidebar-text': '216 14% 36%',
    '--sidebar-text-active': '218 70% 36%',
    '--titlebar-bg': '214 26% 93%',
    '--titlebar-text': '216 14% 36%',
    '--titlebar-close-hover-bg': '0 72% 49%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // Form controls
    '--input-bg': '210 40% 99%',
    '--input-border': '214 22% 82%',
    '--input-focus-border': '218 70% 44%',
    '--input-focus-ring': '218 70% 44%',
    '--input-placeholder': '216 10% 46%',

    // Status colours (light surface: -strong is the text colour that meets contrast, see types.ts).
    // The amber fill is too light for white text, so the warning -foreground is dark.
    '--success': '152 58% 32%',
    '--success-foreground': '0 0% 100%',
    '--success-strong': '152 60% 23%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '30 80% 10%',
    '--warning-strong': '28 90% 29%',
    '--info': '190 78% 31%',
    '--info-foreground': '0 0% 100%',
    '--info-strong': '190 80% 23%',
  },
}

export default frost

import type { ThemeDefinition } from './types'
import { t } from '@/i18n'

/**
 * Orchid - soft pink-white light theme.
 * Blush-tinted surfaces, plum text and a deep orchid-magenta accent. The accent hue
 * (318) sits well away from the destructive red, so primary and delete buttons
 * stay distinguishable.
 */
const orchid: ThemeDefinition = {
  id: 'orchid',
  get name() { return t('theme.orchid') },
  isDark: false,
  previewColors: {
    bg: '#faf5f7',
    sidebar: '#f1e9ed',
    primary: '#9d2579',
    accent: '#f1e4ec',
  },
  vars: {
    // Base colours - blush white with plum-tinted text
    '--background': '330 33% 97%',
    '--foreground': '320 22% 15%',
    '--card': '330 40% 99%',
    '--card-foreground': '320 22% 15%',
    // Floating panels keep the card tone: in light themes the shadow separates them.
    '--popover': '330 40% 99%',
    '--primary': '318 62% 38%',
    '--primary-foreground': '0 0% 100%',
    '--secondary': '328 22% 93%',
    '--secondary-foreground': '320 22% 15%',
    '--muted': '328 22% 93%',
    '--muted-foreground': '322 10% 38%',
    '--accent': '325 30% 92%',
    '--accent-foreground': '320 22% 15%',
    '--destructive': '0 72% 49%',
    '--destructive-foreground': '0 0% 100%',
    '--destructive-strong': '0 74% 40%',
    '--border': '326 20% 86%',
    '--input': '326 20% 86%',
    '--ring': '318 62% 38%',
    '--radius': '0.5rem',

    // Regions
    '--sidebar-bg': '328 22% 93%',
    '--sidebar-border': '326 20% 86%',
    '--sidebar-item-active-bg': '324 30% 88%',
    '--sidebar-item-hover-bg': '326 22% 90%',
    '--sidebar-text': '322 10% 36%',
    '--sidebar-text-active': '318 62% 34%',
    '--titlebar-bg': '328 22% 93%',
    '--titlebar-text': '322 10% 36%',
    '--titlebar-close-hover-bg': '0 72% 49%',
    '--titlebar-close-hover-text': '0 0% 100%',

    // Form controls
    '--input-bg': '330 40% 99%',
    '--input-border': '326 20% 84%',
    '--input-focus-border': '318 62% 38%',
    '--input-focus-ring': '318 62% 38%',
    '--input-placeholder': '322 8% 46%',

    // Status colours (light surface: -strong is the text colour that meets contrast, see types.ts).
    // The amber fill is too light for white text, so the warning -foreground is dark.
    '--success': '150 60% 34%',
    '--success-foreground': '0 0% 100%',
    '--success-strong': '152 62% 24%',
    '--warning': '38 92% 50%',
    '--warning-foreground': '30 80% 10%',
    '--warning-strong': '28 90% 29%',
    '--info': '205 80% 42%',
    '--info-foreground': '0 0% 100%',
    '--info-strong': '205 85% 28%',
  },
}

export default orchid

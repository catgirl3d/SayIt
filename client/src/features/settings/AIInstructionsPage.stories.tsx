import type { Meta, StoryObj } from '@storybook/react-vite'
import AIInstructionsPage from './AIInstructionsPage'
import { BUILTIN_APP_RULES } from '@/services/personalization/defaults'

const appPromptRules = BUILTIN_APP_RULES.map((rule) => ({
  ...rule,
  enabled: rule.id === 'vscode',
  matcher: { ...rule.matcher },
}))

const meta = {
  title: 'settings/AIInstructionsPage',
  component: AIInstructionsPage,
  parameters: {
    tauri: {
      settings: {
        aiEnabled: false,
        injectHotwordsToPrompt: true,
        shortcutToggleAi: 'Control+Shift+A',
        aiMinDurationSec: 15,
        shortcutPTT: 'ControlRight',
        shortcutHandsFree: 'AltRight',
        'ai.builtinPromptLanguage': 'en',
        activePresetId: 'meeting-notes',
        presetShortcuts: {
          intent: 'Alt+1',
          faithful: 'Alt+2',
          'meeting-notes': 'Alt+3',
        },
        promptPresets: [
          {
            id: 'meeting-notes',
            name: 'Meeting notes',
            systemPrompt: 'Format spoken updates as concise meeting notes with clear action items.',
          },
        ],
        appPromptRules,
      },
    },
  },
} satisfies Meta<typeof AIInstructionsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

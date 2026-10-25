import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { setAiEnabled } from '@/stores/aiEnabled'
import AIInstructionsPage from './AIInstructionsPage'
import { BUILTIN_APP_RULES } from '@/services/personalization/defaults'

const appPromptRules = BUILTIN_APP_RULES.map((rule) => ({
  ...rule,
  enabled: rule.id === 'vscode',
  matcher: { ...rule.matcher },
}))

const aiCleanup = (enabled: boolean) => async () => {
  await setAiEnabled(enabled)
}

const meta = {
  title: 'settings/AIInstructionsPage',
  component: AIInstructionsPage,
  parameters: {
    tauri: {
      commands: { set_tray_ai_enabled: () => null },
      settings: {
        aiEnabled: true,
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
  beforeEach: aiCleanup(true),
} satisfies Meta<typeof AIInstructionsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

export const AiCleanupOff: Story = {
  beforeEach: aiCleanup(false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText(/hotwords aren't added to the ai prompt/i)).toBeVisible()
    await expect(await canvas.findByText(/works only while ai processing is on/i)).toBeVisible()
    await expect(await canvas.findByText(/presets aren't applied/i)).toBeVisible()
    await expect(await canvas.findByText(/per-app rules aren't applied/i)).toBeVisible()
  },
}

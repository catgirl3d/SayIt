import type { Meta, StoryObj } from '@storybook/react-vite'
import PersonalizationPage from './PersonalizationPage'
import type { UsageSummary } from '@/types/usage'

const usageSummary = {
  takes: 12,
  totalChars: 1840,
  totalDurationSec: 420,
  datedTakes: 12,
  datedChars: 1840,
  maxDurationSec: 84,
  activeDays: 4,
  hourBuckets: [0, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 0, 0, 0, 1, 2, 1, 0, 0, 1, 2, 1, 0, 0],
  apps: [
    { key: 'code.exe', takes: 7, chars: 1100 },
    { key: 'notepad.exe', takes: 5, chars: 740 },
  ],
  workModes: [
    { key: 'local', takes: 8, chars: 1240 },
    { key: 'cloud_api', takes: 4, chars: 600 },
  ],
  promptPresets: [
    { key: 'intent', takes: 6, chars: 920 },
    { key: 'meeting-notes', takes: 6, chars: 920 },
  ],
  firstUsedAt: Date.now() - 4 * 86400000,
  lastUsedAt: Date.now() - 60 * 60 * 1000,
} satisfies UsageSummary

const meta = {
  title: 'settings/PersonalizationPage',
  component: PersonalizationPage,
  parameters: {
    tauri: {
      commands: {
        usage_summary: () => usageSummary,
      },
      settings: {
        'ai.builtinPromptLanguage': 'en',
        promptPresets: [
          {
            id: 'meeting-notes',
            name: 'Meeting notes',
            systemPrompt: 'Format spoken updates as concise meeting notes with clear action items.',
          },
        ],
      },
    },
  },
} satisfies Meta<typeof PersonalizationPage>

export default meta
type Story = StoryObj<typeof meta>

export const WithUsageData: Story = {}

import type { Meta, StoryObj } from '@storybook/react-vite'
import AIServicePage from './AIServicePage'
import type { AiProfile } from './aiProviderCatalog'

const openAiProfile = {
  id: 'ai-storybook-openai',
  provider: 'openai_compat',
  apiUrl: 'https://api.openai.com',
  apiKey: 'sk-storybook-key',
  model: 'gpt-4o-mini',
  check: {
    ok: true,
    at: Date.now() - 20 * 60 * 1000,
    latencyMs: 180,
  },
} satisfies AiProfile

const meta = {
  title: 'settings/AIServicePage',
  component: AIServicePage,
  parameters: {
    tauri: {
      settings: {
        'cloudAi.profiles': [openAiProfile],
        'cloudAi.activeProfileId': openAiProfile.id,
        'cloudAi.profilesMigrated': true,
        workMode: 'cloud_api',
        'server.aiSource': 'managed',
      },
    },
  },
} satisfies Meta<typeof AIServicePage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
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

export const Configured: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // The page title is the only heading with this name: the card below no longer repeats it.
    await canvas.findByRole('radiogroup', { name: 'AI services' })
    await expect(canvas.getAllByRole('heading', { name: 'AI providers' })).toHaveLength(1)

    // The page-level actions share the header with the Help button.
    const testAll = canvas.getByRole('button', { name: 'Test all' })
    await expect(testAll.parentElement).toContainElement(canvas.getByRole('button', { name: 'Help' }))
    await expect(canvas.getByRole('button', { name: /^new$/i })).toBeVisible()
  },
}

import type { Meta, StoryObj } from '@storybook/react-vite'
import AIProviderSection from './AIProviderSection'
import type { AiProfile } from './aiProviderCatalog'

const profiles = [
  {
    id: 'ai-storybook-openai',
    provider: 'openai',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-storybook-openai',
    model: 'gpt-5-mini',
    reasoningEffort: 'high',
    serviceTier: 'priority',
    check: {
      ok: true,
      at: Date.now() - 15 * 60 * 1000,
      latencyMs: 180,
    },
  },
  {
    id: 'ai-storybook-ollama',
    provider: 'ollama',
    apiUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    model: 'qwen2.5:7b',
    check: {
      ok: false,
      at: Date.now() - 45 * 60 * 1000,
      reason: 'The local endpoint refused the connection',
    },
  },
  {
    id: 'ai-storybook-compatible',
    provider: 'openai_compat',
    apiUrl: 'https://gateway.example.test/v1',
    apiKey: 'sk-storybook-compatible',
    model: 'deepseek-chat',
  },
] satisfies AiProfile[]

const settingsFor = (nextProfiles: AiProfile[], activeId: string, workMode: string, serverAiSource: string) => ({
  'cloudAi.profiles': nextProfiles,
  'cloudAi.activeProfileId': activeId,
  'cloudAi.profilesMigrated': true,
  workMode,
  'server.aiSource': serverAiSource,
})

const meta = {
  title: 'settings/AIProviderSection',
  component: AIProviderSection,
} satisfies Meta<typeof AIProviderSection>

export default meta
type Story = StoryObj<typeof meta>

export const ConfiguredProfiles: Story = {
  parameters: {
    tauri: {
      settings: settingsFor(profiles, profiles[0].id, 'cloud_api', 'managed'),
    },
  },
}

export const ServerModeCustomAI: Story = {
  parameters: {
    tauri: {
      settings: settingsFor(profiles, profiles[2].id, 'server', 'custom'),
    },
  },
}

export const EmptyState: Story = {
  parameters: {
    tauri: {
      settings: settingsFor([], '', 'cloud_api', 'managed'),
    },
  },
}

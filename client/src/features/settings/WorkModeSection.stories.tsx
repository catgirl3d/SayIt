import type { Meta, StoryObj } from '@storybook/react-vite'
import WorkModeSection from './WorkModeSection'

const localModelId = 'nemotron-asr-streaming-0.6b-gguf'

const emptyCloudSettings = {
  workMode: 'cloud_api',
  'cloudAsr.profiles': [],
  'cloudAsr.activeProfileId': '',
  'cloudAsr.autoCreatedProviders': [],
  'cloudAsr.omniSystemPrompt': '',
  'cloudAsr.doubao.console': 'new',
  'cloudAsr.doubao.consoleKey': '',
  'cloudAsr.doubao.apiKey': '',
  'cloudAsr.doubao.appId': '',
  'cloudAsr.qwen.apiKey': '',
  'cloudAsr.qwen.workspaceId': '',
  'cloudAsr.mimo.apiKey': '',
  'cloudAsr.groq.apiKey': '',
  'cloudAsr.openai.apiKey': '',
  'cloudAsr.gemini.apiKey': '',
  'cloudAsr.openrouter.apiKey': '',
  'cloudAsr.deepgram.apiKey': '',
  'cloudAsr.custom.apiKey': '',
}

const meta = {
  title: 'settings/WorkModeSection',
  component: WorkModeSection,
} satisfies Meta<typeof WorkModeSection>

export default meta
type Story = StoryObj<typeof meta>

export const ServerDisconnected: Story = {
  args: { value: 'server', onChange: () => undefined },
  parameters: {
    tauri: { settings: { workMode: 'server' } },
  },
}

export const LocalReady: Story = {
  args: { value: 'local', onChange: () => undefined },
  parameters: {
    tauri: {
      commands: {
        list_downloaded_models: () => [{ id: localModelId, complete: true }],
      },
      settings: {
        workMode: 'local',
        'localAsr.modelId': localModelId,
      },
    },
  },
}

export const CloudNeedsSetup: Story = {
  args: { value: 'cloud_api', onChange: () => undefined },
  parameters: {
    tauri: { settings: emptyCloudSettings },
  },
}

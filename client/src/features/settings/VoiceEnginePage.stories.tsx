import type { Meta, StoryObj } from '@storybook/react-vite'
import VoiceEnginePage from './VoiceEnginePage'
import type { AsrProfile } from './asrProviderCatalog'

const deepgramProfile = {
  id: 'asr-storybook-deepgram',
  provider: 'deepgram',
  model: 'nova-3',
  apiKey: 'dg-storybook-key',
  appId: '',
  console: 'new',
  otherKey: '',
  workspaceId: '',
  omniPrompt: '',
  deepgramKeytermsEnabled: false,
  check: {
    ok: true,
    at: Date.now() - 15 * 60 * 1000,
    latencyMs: 420,
    audioSec: 3.2,
  },
} satisfies AsrProfile

const meta = {
  title: 'settings/VoiceEnginePage',
  component: VoiceEnginePage,
  parameters: {
    tauri: {
      settings: {
        workMode: 'cloud_api',
        'speechInput.language': 'en',
        'cloudAsr.profiles': [deepgramProfile],
        'cloudAsr.activeProfileId': deepgramProfile.id,
        'cloudAsr.autoCreatedProviders': [],
        'cloudAsr.omniSystemPrompt': '',
        'cloudAsr.provider': 'deepgram',
        'cloudAsr.apiKey': deepgramProfile.apiKey,
        'cloudAsr.appId': '',
        'cloudAsr.qwen.workspaceId': '',
        'cloudAsr.doubao.console': 'new',
        'cloudAsr.doubao.consoleKey': '',
        'cloudAsr.doubao.apiKey': '',
        'cloudAsr.doubao.appId': '',
        'cloudAsr.qwen.apiKey': '',
        'cloudAsr.mimo.apiKey': '',
        'cloudAsr.groq.apiKey': '',
        'cloudAsr.openai.apiKey': '',
        'cloudAsr.gemini.apiKey': '',
        'cloudAsr.openrouter.apiKey': '',
        'cloudAsr.deepgram.apiKey': '',
        'cloudAsr.custom.apiKey': '',
      },
    },
  },
} satisfies Meta<typeof VoiceEnginePage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

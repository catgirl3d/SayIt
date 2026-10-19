import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import CloudAPISection from './CloudAPISection'
import type { AsrProfile } from './asrProviderCatalog'

const configuredProfiles = [
  {
    id: 'asr-storybook-deepgram',
    provider: 'deepgram',
    model: 'nova-3',
    apiKey: 'dg-storybook-key',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: '',
    deepgramKeytermsEnabled: true,
    check: {
      ok: true,
      at: Date.now() - 10 * 60 * 1000,
      latencyMs: 420,
      audioSec: 3.2,
    },
  },
  {
    id: 'asr-storybook-qwen-realtime',
    provider: 'qwen_realtime',
    model: 'qwen3-asr-flash-realtime',
    apiKey: 'sk-storybook-qwen',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: '',
  },
  {
    id: 'asr-storybook-qwen-omni',
    provider: 'qwen_omni_35_plus',
    model: 'qwen3.5-omni-plus',
    apiKey: 'sk-storybook-omni',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: 'Keep the transcript concise, preserve the original language, and remove fillers.',
    check: {
      ok: false,
      at: Date.now() - 2 * 60 * 60 * 1000,
      reason: 'Quota is not available for this account',
    },
  },
  {
    id: 'asr-storybook-openai',
    provider: 'openai_transcribe',
    model: 'gpt-4o-mini-transcribe',
    apiKey: 'sk-storybook-openai',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: '',
  },
] satisfies AsrProfile[]

const emptyLegacyAsrSettings = {
  'cloudAsr.provider': 'deepgram',
  'cloudAsr.apiKey': 'dg-storybook-key',
  'cloudAsr.appId': '',
  'cloudAsr.doubao.console': 'new',
  'cloudAsr.doubao.consoleKey': '',
  'cloudAsr.doubao.apiKey': '',
  'cloudAsr.doubao.appId': '',
  'cloudAsr.omniSystemPrompt': '',
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

const settingsFor = (profiles: AsrProfile[], activeProfileId: string) => ({
  ...emptyLegacyAsrSettings,
  'cloudAsr.profiles': profiles,
  'cloudAsr.activeProfileId': activeProfileId,
  'cloudAsr.autoCreatedProviders': [],
})

const meta = {
  title: 'settings/CloudAPISection',
  component: CloudAPISection,
} satisfies Meta<typeof CloudAPISection>

export default meta
type Story = StoryObj<typeof meta>

export const ConfiguredProfiles: Story = {
  args: { speechLanguage: 'en' },
  parameters: {
    tauri: {
      settings: settingsFor(configuredProfiles, configuredProfiles[0].id),
    },
  },
}

export const NewServiceProviderGroups: Story = {
  args: { speechLanguage: 'auto' },
  parameters: {
    tauri: {
      settings: settingsFor([], ''),
    },
  },
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body)
    await userEvent.click(await within(canvasElement).findByRole('button', { name: 'New' }))

    const dialog = await body.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: /^Deepgram/ }))

    for (const heading of ['Global', 'China', 'Custom endpoint']) {
      await expect(await body.findByText(heading)).toBeVisible()
    }
    await userEvent.click(body.getByRole('button', { name: /^OpenAI · / }))
    await expect(within(dialog).getByRole('button', { name: /^OpenAI · / })).toBeVisible()
  },
}

export const EmptyState: Story = {
  args: { speechLanguage: 'auto' },
  parameters: {
    tauri: {
      settings: settingsFor([], ''),
    },
  },
}

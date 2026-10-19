import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import Dictionary from './Dictionary'
import type { AsrProfile } from '@/features/settings/asrProviderCatalog'

const groqProfile = {
  id: 'asr-storybook-groq',
  provider: 'groq_whisper',
  model: 'whisper-large-v3-turbo',
  apiKey: 'gsk-storybook-key',
  appId: '',
  console: 'new',
  otherKey: '',
  workspaceId: '',
  omniPrompt: '',
} satisfies AsrProfile

const hotwordSettings = {
  builtinSetWords: { ai: ['SayIt', 'Storybook'] },
  builtinSetActive: { ai: true },
  customHotwordThemes: [{ id: 'storybook', name: 'Storybook terms', words: ['Vitest'] }],
  customThemeActive: { storybook: true },
  manualHotwords: [],
}

const cloudEngineSettings = {
  ...hotwordSettings,
  workMode: 'cloud_api',
  'cloudAsr.profiles': [groqProfile],
  'cloudAsr.activeProfileId': groqProfile.id,
  'cloudAsr.autoCreatedProviders': [],
}

const meta = {
  title: 'pages/Dictionary',
  component: Dictionary,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      settings: hotwordSettings,
      commands: {
        asr_hotword_capability_matrix: () => ({
          deepgram: { delivery: 'vocabulary', clientCap: 40 },
          server: { delivery: 'context', clientCap: null },
          local: { delivery: 'not_wired_up', clientCap: null },
          groq_whisper: { delivery: 'not_wired_up', clientCap: null },
        }),
      },
    },
  },
} satisfies Meta<typeof Dictionary>

export default meta
type Story = StoryObj<typeof meta>

const engineNotice = (canvasElement: HTMLElement) => canvasElement.querySelector('[role="status"]')

export const Loaded: Story = {
  play: async ({ canvasElement }) => {
    const trigger = canvasElement.querySelector('svg.lucide-info')?.parentElement
    if (!trigger) throw new Error('Dictionary capability information trigger is missing')
    fireEvent.mouseEnter(trigger)

    await waitFor(() => {
      const canvasText = canvasElement.textContent ?? ''
      const bodyText = document.body.textContent ?? ''
      if (!canvasText.includes('SayIt') || !bodyText.includes('Deepgram')) {
        throw new Error('Dictionary did not render the seeded hotword and capability payload')
      }
    })

    // Server mode sends hotwords, so the engine notice stays hidden once the capability matrix has loaded.
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (engineNotice(canvasElement)) throw new Error('Server mode must not show the engine notice')
  },
}

export const CloudEngineIgnoresHotwords: Story = {
  parameters: { tauri: { settings: cloudEngineSettings } },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const text = engineNotice(canvasElement)?.textContent ?? ''
      if (!text.includes('does not send hotwords to speech recognition')) {
        throw new Error('Dictionary did not warn that the active cloud provider ignores hotwords')
      }
      if (!text.includes('Send hotwords to the AI prompt') || !text.includes('AI cleanup')) {
        throw new Error('The engine notice must point to the AI prompt injection toggle')
      }
    })
  },
}

export const LocalEngineIgnoresHotwords: Story = {
  parameters: { tauri: { settings: { ...hotwordSettings, workMode: 'local' } } },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const text = engineNotice(canvasElement)?.textContent ?? ''
      if (!text.includes('Local mode') || !text.includes('does not send hotwords')) {
        throw new Error('Dictionary did not warn that local mode ignores hotwords')
      }
    })
  },
}

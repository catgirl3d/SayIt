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
} satisfies AsrProfile

const deepgramEngineSettings = (keytermsEnabled: boolean, extra: Record<string, unknown> = {}) => ({
  ...hotwordSettings,
  ...extra,
  workMode: 'cloud_api',
  'cloudAsr.profiles': [{ ...deepgramProfile, deepgramKeytermsEnabled: keytermsEnabled }],
  'cloudAsr.activeProfileId': deepgramProfile.id,
  'cloudAsr.autoCreatedProviders': [],
})

// 200 short terms estimate to about 600 tokens, above the 500-token Deepgram budget.
const overBudgetTerms = Array.from({ length: 200 }, (_, index) => `Term${index}`)

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

export const DeepgramOptInOff: Story = {
  parameters: { tauri: { settings: deepgramEngineSettings(false) } },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      const notice = engineNotice(canvasElement)
      if (!notice?.textContent?.includes('does not receive your hotwords')) {
        throw new Error('Dictionary did not warn that Deepgram receives no hotwords without the profile opt-in')
      }
      if (!notice.textContent.includes('Send dictionary terms to Deepgram')) {
        throw new Error('The Deepgram notice must name the profile option')
      }
      if (notice.querySelector('a')?.getAttribute('href') !== '/voice-engine') {
        throw new Error('The Deepgram notice must link to the voice engine settings')
      }
    })
  },
}

export const DeepgramOverTokenBudget: Story = {
  parameters: {
    tauri: {
      settings: deepgramEngineSettings(true, {
        customHotwordThemes: [{ id: 'storybook', name: 'Storybook terms', words: overBudgetTerms }],
      }),
    },
  },
  play: async ({ canvasElement }) => {
    await waitFor(() => {
      if (!engineNotice(canvasElement)?.textContent?.includes('exceed the Deepgram limit (500)')) {
        throw new Error('Dictionary did not warn that the hotword list exceeds the Deepgram token limit')
      }
    })
  },
}

export const DeepgramSendsHotwords: Story = {
  parameters: { tauri: { settings: deepgramEngineSettings(true) } },
  play: async ({ canvasElement }) => {
    // The seeded list is small and the profile opted in, so no notice may appear once the engine has resolved.
    await waitFor(() => {
      if (!(canvasElement.textContent ?? '').includes('SayIt')) throw new Error('Dictionary did not render the seeded hotwords')
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    if (engineNotice(canvasElement)) throw new Error('An opted-in Deepgram profile within budget must not show a notice')
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

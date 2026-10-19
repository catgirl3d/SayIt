import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import Dictionary from './Dictionary'
import type { AsrProfile } from '@/features/settings/asrProviderCatalog'
import { getWorkMode, switchProvider } from '@/services/transcription'

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
          groq_whisper: { delivery: 'not_wired_up', clientCap: null },
        }),
      },
    },
  },
} satisfies Meta<typeof Dictionary>

export default meta
type Story = StoryObj<typeof meta>

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
  },
}

// Switching the work mode disconnects the previous provider, which mirrors its events to the debug
// log and closes any provider streams through these commands.
const providerSwitchCommands = {
  append_debug_log: () => undefined,
  doubao_stream_close: () => undefined,
  qwen_stream_close: () => undefined,
  qwen_audio_stream_close: () => undefined,
  deepgram_stream_close: () => undefined,
}

let modeBeforeStory: ReturnType<typeof getWorkMode> | null = null

// The page reads the engine dictation really uses, so the mode is switched the way the app does.
// The notice variants themselves are covered by the HotwordEngineNotices stories.
export const CloudEngineIgnoresHotwords: Story = {
  parameters: {
    tauri: {
      commands: providerSwitchCommands,
      settings: {
        ...hotwordSettings,
        'cloudAsr.profiles': [groqProfile],
        'cloudAsr.activeProfileId': groqProfile.id,
        'cloudAsr.autoCreatedProviders': [],
      },
    },
  },
  beforeEach: async () => {
    modeBeforeStory = getWorkMode()
    await switchProvider('cloud_api')
  },
  play: async ({ canvasElement }) => {
    try {
      await waitFor(() => {
        const text = canvasElement.querySelector('[role="status"]')?.textContent ?? ''
        if (!text.includes('does not send hotwords to speech recognition')) {
          throw new Error('Dictionary did not warn that the active cloud provider ignores hotwords')
        }
      })
    } finally {
      // Restored inside the run: the provider commands above exist only while the story's Tauri session is open.
      if (modeBeforeStory !== null) await switchProvider(modeBeforeStory)
    }
  },
}

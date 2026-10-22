import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import Dictionary from './Dictionary'
import type { AsrProfile } from '@/features/settings/asrProviderCatalog'
import { BUILTIN_SETS } from '@/services/hotwords/model'
import { getSetting } from '@/services/store'
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

const geminiProfile = {
  id: 'asr-storybook-gemini',
  provider: 'gemini_transcribe',
  model: 'gemini-3.5-transcribe',
  apiKey: 'gemini-storybook-key',
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

// More than the 100-word client cap of Gemini, so the cap warning has something to report.
const manyHotwordsSettings = {
  ...hotwordSettings,
  customHotwordThemes: [{ id: 'many', name: 'Many terms', words: Array.from({ length: 101 }, (_, i) => `term${i}`) }],
  customThemeActive: { many: true },
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
          gemini_transcribe: { delivery: 'instruction', clientCap: 100 },
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

// A fresh install has no saved hotword state. null replaces the meta's seeded keys instead of being
// deep-merged with them, and the store reads it back like a missing key.
export const FreshInstall: Story = {
  parameters: {
    tauri: {
      settings: {
        builtinSetWords: null,
        builtinSetActive: null,
        customHotwordThemes: null,
        customThemeActive: null,
      },
    },
  },
  play: async ({ canvasElement }) => {
    // Opening the page persists the flags it resolved; the AI set must stay off on screen and in the store.
    await waitFor(async () => {
      const label = Array.from(canvasElement.querySelectorAll('p'))
        .find((p) => p.textContent === BUILTIN_SETS.ai.label)
      const aiSwitch = label?.parentElement?.parentElement?.querySelector('[role="switch"]')
      if (!aiSwitch) throw new Error('Dictionary did not render the built-in AI set')
      if (aiSwitch.getAttribute('aria-checked') !== 'false') {
        throw new Error('Dictionary showed the built-in AI set as on for a fresh install')
      }
      const stored = await getSetting<Record<string, unknown>>('builtinSetActive', {})
      if (stored.ai !== false) {
        throw new Error('Dictionary did not persist the built-in AI set as off')
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
async function enterCloudApiMode() {
  modeBeforeStory = getWorkMode()
  await switchProvider('cloud_api')
}

// Restored inside the run: the provider commands above exist only while the story's Tauri session is open.
async function restoreWorkMode() {
  if (modeBeforeStory !== null) await switchProvider(modeBeforeStory)
}

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
  beforeEach: enterCloudApiMode,
  play: async ({ canvasElement }) => {
    try {
      await waitFor(() => {
        const text = canvasElement.querySelector('[role="status"]')?.textContent ?? ''
        if (!text.includes('does not send hotwords to speech recognition')) {
          throw new Error('Dictionary did not warn that the active cloud provider ignores hotwords')
        }
      })
    } finally {
      await restoreWorkMode()
    }
  },
}

export const CloudEngineWithWordCap: Story = {
  parameters: {
    tauri: {
      commands: providerSwitchCommands,
      settings: {
        ...manyHotwordsSettings,
        'cloudAsr.profiles': [geminiProfile],
        'cloudAsr.activeProfileId': geminiProfile.id,
        'cloudAsr.autoCreatedProviders': [],
      },
    },
  },
  beforeEach: enterCloudApiMode,
  play: async ({ canvasElement }) => {
    try {
      await waitFor(() => {
        const text = canvasElement.textContent ?? ''
        if (!text.includes('use only the first 100 words')) {
          throw new Error('Dictionary did not show the word-cap warning for the Gemini engine')
        }
      })
    } finally {
      await restoreWorkMode()
    }
  },
}

export const CloudEngineWithoutWordCap: Story = {
  parameters: {
    tauri: {
      commands: providerSwitchCommands,
      settings: {
        ...manyHotwordsSettings,
        'cloudAsr.profiles': [groqProfile],
        'cloudAsr.activeProfileId': groqProfile.id,
        'cloudAsr.autoCreatedProviders': [],
      },
    },
  },
  beforeEach: enterCloudApiMode,
  play: async ({ canvasElement }) => {
    try {
      // This notice appears only after both the engine and the capability matrix have loaded.
      await waitFor(() => {
        const text = canvasElement.textContent ?? ''
        if (!text.includes('does not send hotwords to speech recognition')) {
          throw new Error('Dictionary did not finish loading the cloud engine and capability matrix')
        }
      })
      if ((canvasElement.textContent ?? '').includes('use only the first')) {
        throw new Error('Dictionary showed the word-cap warning for an engine without a word cap')
      }
    } finally {
      await restoreWorkMode()
    }
  },
}

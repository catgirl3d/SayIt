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
  builtinSetWords: { ai: ['SayIt'] },
  builtinSetExtraWords: { ai: ['Storybook'] },
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

function getAiCard(canvasElement: HTMLElement) {
  const label = Array.from(canvasElement.querySelectorAll('p'))
    .find((p) => p.textContent === BUILTIN_SETS.ai.label)
  const card = label?.closest('div.rounded-xl')
  if (!(card instanceof HTMLElement)) throw new Error('Dictionary did not render the built-in AI card')
  return card
}

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
        builtinSetExtraWords: null,
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

export const AddTermToBuiltinSet: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitFor(() => {
      const element = getAiCard(canvasElement)
      if (!element.querySelector('input')) throw new Error('Built-in AI card does not have an add-words input')
      return element
    })

    const input = card.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('Built-in AI add-words input is missing')
    fireEvent.change(input, { target: { value: 'Project Falcon' } })

    const addButton = Array.from(card.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Add')
    if (!(addButton instanceof HTMLButtonElement)) throw new Error('Built-in AI add button is missing')
    fireEvent.click(addButton)

    await waitFor(async () => {
      if (!card.textContent?.includes('Project Falcon')) {
        throw new Error('Built-in AI card did not render the added word')
      }
      const extras = await getSetting<Record<string, string[]>>('builtinSetExtraWords', {})
      if (!extras.ai?.includes('Project Falcon')) {
        throw new Error('Built-in extra words did not persist the added word')
      }
      const words = await getSetting<Record<string, string[]>>('builtinSetWords', {})
      if (words.ai?.includes('Project Falcon')) {
        throw new Error('Built-in default words persisted the user-added word')
      }
      const chip = Array.from(card.querySelectorAll('span'))
        .some((span) => span.textContent?.trim() === 'Project Falcon')
      if (!chip) throw new Error('Built-in AI word chip is missing')
    })
  },
}

export const AddTermToCustomTheme: Story = {
  play: async ({ canvasElement }) => {
    const label = Array.from(canvasElement.querySelectorAll('p'))
      .find((p) => p.textContent === 'Storybook terms')
    const card = label?.closest('div.rounded-xl')
    if (!(card instanceof HTMLElement)) throw new Error('Dictionary did not render the custom category card')

    const input = card.querySelector('input')
    if (!(input instanceof HTMLInputElement)) throw new Error('Custom category add-words input is missing')
    fireEvent.change(input, { target: { value: 'Figma plugin' } })

    const addButton = Array.from(card.querySelectorAll('button'))
      .find((button) => button.textContent?.trim() === 'Add')
    if (!(addButton instanceof HTMLButtonElement)) throw new Error('Custom category add button is missing')
    fireEvent.click(addButton)

    await waitFor(async () => {
      if (!card.textContent?.includes('Figma plugin')) {
        throw new Error('Custom category did not render the added word')
      }
      const themes = await getSetting<Array<{ id: string; words: string[] }>>('customHotwordThemes', [])
      const theme = themes.find((item) => item.id === 'storybook')
      if (!theme?.words.includes('Figma plugin')) {
        throw new Error('Custom category did not persist the added word')
      }
    })
  },
}

export const ExtraThatIsNowDefaultStaysVisible: Story = {
  parameters: {
    tauri: {
      settings: {
        ...hotwordSettings,
        builtinSetWords: { ai: ['SayIt'] },
        builtinSetExtraWords: { ai: [BUILTIN_SETS.ai.words[0]] },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const card = await waitFor(() => getAiCard(canvasElement))
    const word = BUILTIN_SETS.ai.words[0]
    // The saved defaults snapshot predates this word; only the extras store can keep it visible.
    await waitFor(() => {
      if (!card.textContent?.includes(word)) {
        throw new Error('User extra that is now a default disappeared from the built-in category')
      }
    })
  },
}

export const CustomThemeIdCannotStealBuiltinDraft: Story = {
  parameters: {
    tauri: {
      settings: {
        ...hotwordSettings,
        customHotwordThemes: [{ id: 'builtin:ai', name: 'Collision theme', words: ['Vitest'] }],
        customThemeActive: { 'builtin:ai': true },
      },
    },
  },
  play: async ({ canvasElement }) => {
    const customLabel = Array.from(canvasElement.querySelectorAll('p'))
      .find((p) => p.textContent === 'Collision theme')
    const customCard = customLabel?.closest('div.rounded-xl')
    if (!(customCard instanceof HTMLElement)) throw new Error('Dictionary did not render the custom category card')
    const customInput = customCard.querySelector('input')
    if (!(customInput instanceof HTMLInputElement)) throw new Error('Custom category input is missing')

    const aiCard = getAiCard(canvasElement)
    const builtinInput = aiCard.querySelector('input')
    if (!(builtinInput instanceof HTMLInputElement)) throw new Error('Built-in AI input is missing')

    fireEvent.change(customInput, { target: { value: 'ThemeDraft' } })
    fireEvent.change(builtinInput, { target: { value: 'BuiltinDraft' } })

    await waitFor(() => {
      if (customInput.value !== 'ThemeDraft') {
        throw new Error('Typing in the built-in category changed the custom category draft')
      }
      if (builtinInput.value !== 'BuiltinDraft') {
        throw new Error('Typing in the custom category changed the built-in category draft')
      }
    })
  },
}

export const RemoveUserWordFromBuiltinSet: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitFor(() => getAiCard(canvasElement))
    const deleteButton = card.querySelector('button[aria-label="Delete Storybook"]')
    if (!(deleteButton instanceof HTMLButtonElement)) throw new Error('Built-in extra word chip is missing')

    fireEvent.click(deleteButton)

    await waitFor(async () => {
      const extras = await getSetting<Record<string, string[]>>('builtinSetExtraWords', {})
      if (extras.ai?.includes('Storybook')) {
        throw new Error('Removing a user word left it in the extras store')
      }
      const words = await getSetting<Record<string, string[]>>('builtinSetWords', {})
      if (JSON.stringify(words.ai) !== JSON.stringify(['SayIt'])) {
        throw new Error('Removing a user word changed the saved default words')
      }
      if (card.textContent?.includes('Storybook')) {
        throw new Error('Built-in AI card still renders the removed user word')
      }
    })
  },
}

export const ResetBuiltinSet: Story = {
  play: async ({ canvasElement }) => {
    const card = await waitFor(() => getAiCard(canvasElement))

    const resetButton = card.querySelector('button svg.lucide-rotate-ccw')?.closest('button')
    if (!(resetButton instanceof HTMLButtonElement)) throw new Error('Built-in AI reset button is missing')
    fireEvent.click(resetButton)

    const confirmButton = await waitFor(() => {
      const button = Array.from(card.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.trim() === 'Confirm reset')
      if (!(button instanceof HTMLButtonElement)) throw new Error('Built-in AI reset confirmation is missing')
      return button
    })
    fireEvent.click(confirmButton)

    await waitFor(async () => {
      const extras = await getSetting<Record<string, string[]>>('builtinSetExtraWords', {})
      if (extras.ai && extras.ai.length > 0) {
        throw new Error('Built-in extra words were not cleared by reset')
      }
      const words = await getSetting<Record<string, string[]>>('builtinSetWords', {})
      if (JSON.stringify(words.ai) !== JSON.stringify(BUILTIN_SETS.ai.words)) {
        throw new Error('Built-in reset did not restore the default words')
      }
      if (card.textContent?.includes('Storybook')) {
        throw new Error('Built-in AI card still renders the extra word after reset')
      }
    })
  },
}

export const ResetHiddenForDefaultWords: Story = {
  parameters: {
    tauri: {
      settings: {
        ...hotwordSettings,
        builtinSetWords: { ai: [...BUILTIN_SETS.ai.words] },
        builtinSetExtraWords: null,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const card = await waitFor(() => getAiCard(canvasElement))

    await waitFor(() => {
      if (!card.querySelector('input')) throw new Error('Built-in AI card has not rendered its add-words input')
    })
    if (card.querySelector('button svg.lucide-rotate-ccw')) {
      throw new Error('Built-in AI reset button is visible for default words')
    }
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
  unload_local_model: () => undefined,
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

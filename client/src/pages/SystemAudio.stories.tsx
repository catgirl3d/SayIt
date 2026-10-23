import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, waitFor, within } from 'storybook/test'
import SystemAudio from './SystemAudio'
import { switchProvider, getWorkMode } from '@/services/transcription'
import {
  beginRun,
  clearPipelineTrace,
  failRun,
  finishRun,
  markQueued,
  setPipelineDebugEnabled,
} from '@/services/pipelineTrace'

const asrProfile = {
  id: 'storybook-deepgram',
  provider: 'deepgram',
  model: 'nova-3',
  apiKey: 'storybook-key',
  appId: '',
  console: 'new',
  otherKey: '',
  workspaceId: '',
  omniPrompt: '',
  deepgramKeytermsEnabled: false,
}

const settings = {
  'systemAudio.deviceId': 'storybook-output',
  'systemAudio.sourceLanguage': 'en',
  'systemAudio.targetLanguage': 'uk',
  'systemAudio.maxSegmentSec': 8,
  'systemAudio.dualSubtitles': true,
  'systemAudio.liveRecognitionEnabled': false,
  'systemAudio.debugPipeline': false,
  'systemAudio.asrOnlyTest': false,
  'systemAudio.deepgramLeadingContext': false,
  'systemAudio.transcriptEnabled': true,
  'systemAudio.transcriptDir': 'C:\\Storybook\\Subtitles',
  promptPresets: [],
  'ai.builtinPromptLanguage': 'en',
  'cloudAsr.profiles': [asrProfile],
  'cloudAsr.activeProfileId': 'storybook-deepgram',
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
} as const

function commands() {
  return {
    list_system_audio_devices: () => [
      { id: 'storybook-output', name: 'Storybook speakers', isDefault: true },
      { id: 'storybook-headphones', name: 'Storybook headphones', isDefault: false },
    ],
    start_system_audio_capture: () => undefined,
    stop_system_audio_capture: () => undefined,
    resolve_subtitle_transcript_dir: ({ dir }: { dir?: string | null }) => dir || 'C:\\Storybook\\Subtitles',
    set_escape_action_mode: () => undefined,
    hide_overlay: () => undefined,
    append_debug_log: () => undefined,
    doubao_stream_close: () => undefined,
    qwen_stream_close: () => undefined,
    qwen_audio_stream_close: () => undefined,
    deepgram_stream_close: () => undefined,
  }
}

const meta = {
  title: 'pages/SystemAudio',
  component: SystemAudio,
  beforeEach: async ({ parameters }) => {
    clearPipelineTrace()
    setPipelineDebugEnabled(false)

    const requestedMode = (parameters as { systemAudioMode?: string }).systemAudioMode
    const previousMode = getWorkMode()
    if (requestedMode === 'cloud_api' && previousMode !== 'cloud_api') {
      await switchProvider('cloud_api')
    }

    if ((parameters as { systemAudioTrace?: boolean }).systemAudioTrace) {
      setPipelineDebugEnabled(true)
      const completedRun = beginRun({
        mode: 'cloud_api',
        speechMs: 1_800,
        closeReason: 'silence',
        recognitionKind: 'finished',
      })
      if (completedRun !== null) {
        markQueued(completedRun)
        finishRun(completedRun, {
          asrMs: 340,
          llmMs: 220,
          overlayMs: 16,
          asrEngine: 'deepgram',
          asrModel: 'nova-3',
          aiProvider: 'server',
          aiModel: 'subtitle-translation',
          asrChars: 38,
          captionChars: 42,
        })
      }

      const failedRun = beginRun({
        mode: 'cloud_api',
        speechMs: 2_400,
        closeReason: 'dropout',
        recognitionKind: 'live',
        asrOnly: true,
      })
      if (failedRun !== null) failRun(failedRun, 'timeout', 'The recognition provider timed out')
    }

    return () => {
      clearPipelineTrace()
      setPipelineDebugEnabled(false)
      void systemAudioCleanup(previousMode)
    }
  },
} satisfies Meta<typeof SystemAudio>

async function systemAudioCleanup(previousMode: ReturnType<typeof getWorkMode>) {
  if (getWorkMode() !== previousMode) await switchProvider(previousMode)
}

export default meta
type Story = StoryObj<typeof meta>

export const IdleConfigured: Story = {
  parameters: {
    tauri: {
      commands: commands(),
      settings,
    },
  },
}

export const CloudConfigured: Story = {
  parameters: {
    systemAudioMode: 'cloud_api',
    tauri: {
      commands: commands(),
      settings: {
        ...settings,
        'systemAudio.liveRecognitionEnabled': true,
      },
    },
  },
}

export const PipelineDiagnostics: Story = {
  parameters: {
    systemAudioMode: 'cloud_api',
    systemAudioTrace: true,
    tauri: {
      commands: commands(),
      settings: {
        ...settings,
        'systemAudio.debugPipeline': true,
        'systemAudio.asrOnlyTest': true,
        'systemAudio.deepgramLeadingContext': true,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // Every diagnostics switch keeps its own explanation next to it; the story protects all three
    // pairs, not only the experiment whose saved value opened the section.
    const debug = await canvas.findByRole('switch', { name: /^pipeline debug$/i })
    await expect(debug).toBeChecked()
    await expect(debug).toBeEnabled()
    await expect(canvas.getByText(/records each processing run/i)).toBeVisible()

    const asrOnly = await canvas.findByRole('switch', { name: /^recognition-only test mode$/i })
    await expect(asrOnly).toBeChecked()
    await expect(canvas.getByText(/subtitles show raw recognition without translation/i)).toBeVisible()

    const overlap = await canvas.findByRole('switch', { name: /^experimental: deepgram overlap$/i })
    await waitFor(() => expect(overlap).toBeChecked())
    await expect(overlap).toBeEnabled()
    await expect(canvas.getByText(/deepgram only: each fragment also gets the last second/i)).toBeVisible()
  },
}

export const DiagnosticsOtherEngine: Story = {
  parameters: {
    systemAudioMode: 'cloud_api',
    tauri: {
      commands: commands(),
      settings: {
        ...settings,
        'systemAudio.debugPipeline': true,
        'cloudAsr.profiles': [{ ...asrProfile, id: 'storybook-doubao', provider: 'doubao_v2', model: 'Doubao-Seed-ASR-2.0' }],
        'cloudAsr.activeProfileId': 'storybook-doubao',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The section is open because the trace switch is saved on; only the Deepgram experiment is absent.
    await expect(await canvas.findByRole('switch', { name: /^pipeline debug$/i })).toBeChecked()
    await expect(canvas.getByRole('switch', { name: /^recognition-only test mode$/i })).toBeVisible()
    await expect(canvas.queryByRole('switch', { name: /experimental: deepgram overlap/i })).toBeNull()
    await expect(canvas.queryByText(/deepgram only: each fragment also gets the last second/i)).toBeNull()
  },
}

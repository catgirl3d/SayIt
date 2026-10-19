import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import FileTranscription from './FileTranscription'
import {
  fileTranscriptionService,
  type FileMediaInfo,
  type FileTranscriptionSnapshot,
} from '@/services/fileTranscription'

const localModelId = 'nemotron-asr-streaming-0.6b-gguf'

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

const fixedAsrProfile = {
  ...asrProfile,
  id: 'storybook-fixed-window',
  provider: 'groq_whisper',
  model: 'whisper-large-v3-turbo',
}

const openaiTranscribeProfile = {
  ...asrProfile,
  id: 'storybook-openai',
  provider: 'openai_transcribe',
  model: 'whisper-1',
}

const settings = {
  'fileTranscription.engine': 'local',
  'fileTranscription.modelId': localModelId,
  'fileTranscription.cloudProfileId': 'storybook-deepgram',
  'fileTranscription.cloudWindowSeconds': null,
  'fileTranscription.language': 'en',
  'speechInput.language': 'en',
  'localAsr.modelId': localModelId,
  'localAsr.accelerator': 'cpu',
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
  builtinSetWords: {},
  builtinSetActive: { ai: true },
  customHotwordThemes: [],
  customThemeActive: {},
} as const

const cloudSettings = {
  ...settings,
  'fileTranscription.engine': 'cloud',
  'fileTranscription.cloudWindowSeconds': 300,
  'cloudAsr.profiles': [asrProfile, fixedAsrProfile],
  'cloudAsr.activeProfileId': asrProfile.id,
} as const

const cloudAutoSettings = {
  ...cloudSettings,
  'fileTranscription.cloudWindowSeconds': null,
} as const

const mediaInfo: FileMediaInfo = {
  durationMs: 78_000,
  audioTracks: [{ index: 0, label: 'Main audio', isDefault: true }],
}

const runningSnapshot: FileTranscriptionSnapshot = {
  jobId: 'storybook-file-job-running',
  sequence: 2,
  phase: 'transcribing',
  engine: 'local',
  cloudLabel: null,
  durationMs: 78_000,
  processedMs: 78_000,
  savedMs: 31_000,
  text: 'The draft transcript is available while the remaining audio is processed.',
  draftPath: 'C:\\Storybook\\meeting.draft.txt',
  txtPath: null,
  markdownPath: null,
  error: null,
  warning: 'The draft is saved continuously while transcription runs.',
  retryableExport: false,
  resourcesReleased: false,
}

const completedSnapshot: FileTranscriptionSnapshot = {
  jobId: 'storybook-file-job-completed',
  sequence: 3,
  phase: 'completed',
  engine: 'local',
  cloudLabel: null,
  durationMs: 78_000,
  processedMs: 78_000,
  savedMs: 78_000,
  text: 'The completed transcript keeps the original meaning and is ready to review.',
  draftPath: 'C:\\Storybook\\meeting.draft.txt',
  txtPath: 'C:\\Storybook\\meeting.txt',
  markdownPath: 'C:\\Storybook\\meeting.md',
  error: null,
  warning: null,
  retryableExport: false,
  resourcesReleased: true,
}

const failedSnapshot: FileTranscriptionSnapshot = {
  jobId: 'storybook-file-job-failed',
  sequence: 4,
  phase: 'failed',
  engine: 'local',
  cloudLabel: null,
  durationMs: 78_000,
  processedMs: 78_000,
  savedMs: 78_000,
  text: 'The transcript was recognized, but the final export did not complete.',
  draftPath: 'C:\\Storybook\\meeting.draft.txt',
  txtPath: null,
  markdownPath: null,
  error: 'The final text export failed.',
  warning: null,
  retryableExport: true,
  resourcesReleased: true,
}

const cancelledSnapshot: FileTranscriptionSnapshot = {
  ...runningSnapshot,
  jobId: 'storybook-file-job-cancelled',
  sequence: 5,
  phase: 'cancelled',
  warning: null,
  resourcesReleased: true,
}

const cloudRunningSnapshot: FileTranscriptionSnapshot = {
  ...runningSnapshot,
  jobId: 'storybook-cloud-job-running',
  engine: 'cloud',
  cloudLabel: 'Deepgram',
}

function commandsFor(snapshot: FileTranscriptionSnapshot | null) {
  return {
    get_file_transcription_state: () => snapshot,
    detect_ffmpeg_directory: () => null,
    inspect_transcription_file: () => mediaInfo,
    get_file_transcription_cloud_window_options: (args?: { provider?: string }) =>
      args?.provider === 'deepgram' ? [20, 60, 180, 300] : [],
    list_downloaded_models: () => [{ id: localModelId, name: 'Nemotron ASR Streaming 0.6B', complete: true }],
    asr_hotword_capability_matrix: () => ({
      deepgram: { delivery: 'vocabulary', clientCap: null },
      openai_transcribe: { delivery: 'not_wired_up', clientCap: null },
    }),
    start_file_transcription: () => runningSnapshot,
    cancel_file_transcription: () => cancelledSnapshot,
    retry_file_transcription_export: () => completedSnapshot,
    copy_text: () => undefined,
  }
}

const meta = {
  title: 'pages/FileTranscription',
  component: FileTranscription,
  beforeEach: () => {
    fileTranscriptionService.dispose()
    return () => fileTranscriptionService.dispose()
  },
} satisfies Meta<typeof FileTranscription>

export default meta
type Story = StoryObj<typeof meta>

export const IdleReady: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(null),
      settings,
    },
  },
}

export const ChooseFileFromDropZone: Story = {
  parameters: {
    tauri: {
      commands: {
        ...commandsFor(null),
        'plugin:dialog|open': () => 'C:\\Storybook\\meeting.mp4',
      },
      settings,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('heading', { name: 'Choose an audio or video file' }))
    await expect(await canvas.findByText('meeting.mp4')).toBeInTheDocument()
  },
}

export const CloudHotwordsGate: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(null),
      settings: {
        ...settings,
        'fileTranscription.engine': 'cloud',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await waitFor(() => expect(
      canvas.getByText(/is turned off in the Deepgram profile/),
    ).toBeTruthy())
  },
}

export const CloudHotwordsHidden: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(null),
      settings: {
        ...settings,
        'fileTranscription.engine': 'cloud',
        'fileTranscription.cloudProfileId': 'storybook-openai',
        'cloudAsr.profiles': [asrProfile, openaiTranscribeProfile],
        'cloudAsr.activeProfileId': 'storybook-openai',
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)

    await waitFor(() => expect(canvas.getByRole('button', { name: 'Cloud profile' })).toBeTruthy())
    await userEvent.click(canvas.getByRole('button', { name: 'Cloud profile' }))
    await userEvent.click(await body.findByRole('button', { name: 'Deepgram · nova-3' }))
    await waitFor(() => expect(canvas.getByText('Hotwords')).toBeTruthy())

    await userEvent.click(canvas.getByRole('button', { name: 'Cloud profile' }))
    await userEvent.click(await body.findByRole('button', { name: 'OpenAI · whisper-1' }))
    await expect(canvas.queryByText('Hotwords')).toBeNull()
  },
}

export const RunningProgress: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(runningSnapshot),
      settings,
    },
  },
}

export const CompletedTranscript: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(completedSnapshot),
      settings,
    },
  },
}

export const FailedExport: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(failedSnapshot),
      settings,
    },
  },
}

export const CloudFragmentDuration: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(null),
      settings: cloudSettings,
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = within(canvasElement.ownerDocument.body)
    const duration = await canvas.findByRole('button', { name: 'Fragment duration' })
    await expect(duration).toHaveTextContent('5 min')

    const hint = canvas.getByLabelText(/Nominal duration/)
    await userEvent.hover(hint)
    await expect(await body.findByText(/Nominal duration/)).toBeVisible()
    await userEvent.unhover(hint)

    await userEvent.click(duration)
    await userEvent.click(body.getByRole('button', { name: '3 min' }))
    await expect(duration).toHaveTextContent('3 min')

    await userEvent.click(canvas.getByRole('button', { name: 'Cloud profile' }))
    await userEvent.click(body.getByRole('button', { name: 'Groq Whisper · whisper-large-v3-turbo' }))
    await expect(canvas.queryByRole('button', { name: 'Fragment duration' })).toBeNull()
  },
}

export const CloudFragmentDurationAuto: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(null),
      settings: cloudAutoSettings,
    },
  },
}

export const CloudFragmentDurationActive: Story = {
  parameters: {
    tauri: {
      commands: commandsFor(cloudRunningSnapshot),
      settings: cloudSettings,
    },
  },
  play: async ({ canvasElement }) => {
    const duration = await within(canvasElement).findByRole('button', { name: 'Fragment duration' })
    await expect(duration).toBeDisabled()
  },
}

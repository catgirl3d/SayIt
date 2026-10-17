import type { Meta, StoryObj } from '@storybook/react-vite'
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

const settings = {
  'fileTranscription.engine': 'local',
  'fileTranscription.modelId': localModelId,
  'fileTranscription.cloudProfileId': 'storybook-deepgram',
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

function commandsFor(snapshot: FileTranscriptionSnapshot | null) {
  return {
    get_file_transcription_state: () => snapshot,
    detect_ffmpeg_directory: () => null,
    inspect_transcription_file: () => mediaInfo,
    list_downloaded_models: () => [{ id: localModelId, name: 'Nemotron ASR Streaming 0.6B', complete: true }],
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

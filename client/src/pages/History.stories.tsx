import type { Meta, StoryObj } from '@storybook/react-vite'
import type { HistoryRecord } from '@/services/store'
import History from './History'

const now = Date.now()

const historyRecords: HistoryRecord[] = [
  {
    id: 'history-normal',
    timestamp: now - 20_000,
    asrText: 'We need to review the Storybook harness before the next release.',
    llmText: 'We need to review the Storybook harness before the next release.',
    asrMs: 640,
    llmMs: 280,
    durationSec: 5.8,
    audioDurationSec: 5.6,
    charCount: 68,
    favorite: true,
    audioFilePath: 'C:\\Storybook\\normal.wav',
    appName: 'Visual Studio Code',
    workMode: 'server',
    asrProvider: 'server',
    aiSource: 'server',
    aiStatus: 'applied',
    promptPresetId: 'intent',
  },
  {
    id: 'history-edited',
    timestamp: now - 86_400_000 - 10_800_000,
    asrText: 'The staging notes are ready',
    llmText: 'The staging notes are ready for review.',
    asrMs: 510,
    llmMs: 0,
    durationSec: 3.4,
    charCount: 41,
    manualEditedAt: now - 86_400_000,
    workMode: 'cloud_api',
    asrProvider: 'deepgram',
    aiSource: 'custom',
    aiStatus: 'unavailable',
    aiProvider: 'openai_compat',
    aiModel: 'gpt-4o-mini',
  },
  {
    id: 'history-empty',
    timestamp: now - 2 * 86_400_000,
    asrText: '',
    llmText: '',
    asrMs: 0,
    llmMs: 0,
    durationSec: 3.2,
    charCount: 0,
    isEmpty: true,
    failReasonCode: 'provider_timeout',
    failReason: 'Transcription timed out',
    favorite: false,
    workMode: 'local',
    asrProvider: 'sensevoice-small',
    aiSource: 'none',
    aiStatus: 'skipped',
  },
]

const settings = {
  dismissedNoticeIds: [],
}

const meta = {
  title: 'pages/History',
  component: History,
} satisfies Meta<typeof History>

export default meta
type Story = StoryObj<typeof meta>

export const WithRecords: Story = {
  parameters: {
    tauri: {
      commands: {
        history_list: () => historyRecords,
        history_count: () => historyRecords.length,
      },
      settings,
    },
  },
}

export const Empty: Story = {
  parameters: {
    tauri: {
      commands: {
        history_list: () => [],
        history_count: () => 0,
      },
      settings,
    },
  },
}

export const LoadError: Story = {
  parameters: {
    tauri: {
      commands: {
        history_list: () => { throw new Error('history unavailable') },
        history_count: () => 0,
      },
      settings,
    },
  },
}

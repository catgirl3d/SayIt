import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { t } from '@/i18n'
import { getTauriJournal } from '@/storybook/tauriMock'
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

function hasFavoriteOnlyHistoryCall(): boolean {
  return getTauriJournal().calls.some(({ command, args }) => {
    if (command !== 'history_list') return false
    const query = (args as { query?: { favoriteOnly?: boolean } } | undefined)?.query
    return query?.favoriteOnly === true
  })
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    const favorites = canvas.getByRole('button', { name: t('history.filterFavorites') })
    await userEvent.click(favorites)

    await expect(favorites).toHaveAttribute('aria-pressed', 'true')
    await expect(canvas.getByRole('button', { name: t('history.filterAll') })).toHaveAttribute('aria-pressed', 'false')
    // The filter is not only painted: the list reloads with favoriteOnly=true.
    await waitFor(() => expect(hasFavoriteOnlyHistoryCall()).toBe(true))
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

import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
import { t } from '@/i18n'
import type { HistoryRecord } from '@/services/store'
import HistoryRecordList from './HistoryRecordList'

const now = Date.now()

const records: HistoryRecord[] = [
  {
    id: 'history-server-success',
    timestamp: now - 15 * 60 * 1000,
    asrText: 'We should review the release notes before the next deploy.',
    llmText: 'We should review the release notes before the next deploy.',
    asrMs: 820,
    llmMs: 310,
    durationSec: 5.4,
    audioDurationSec: 5.1,
    asrDurationSec: 4.9,
    charCount: 61,
    favorite: true,
    audioFilePath: 'C:\\recordings\\release-notes.wav',
    workMode: 'server',
    asrProvider: 'server',
    aiProvider: 'server',
    aiStatus: 'applied',
    promptPresetId: 'intent',
    promptPresetName: 'Intent processing',
    autoAppliedHotwords: ['release notes', 'deploy'],
    manualEditedAt: now - 10 * 60 * 1000,
  },
  {
    id: 'history-cloud-skipped',
    timestamp: now - 26 * 60 * 60 * 1000,
    asrText: 'The cloud provider returned the transcript without processing.',
    llmText: '',
    asrMs: 640,
    llmMs: 0,
    durationSec: 4.2,
    audioDurationSec: 4.0,
    charCount: 65,
    audioFilePath: 'C:\\recordings\\cloud-skipped.wav',
    workMode: 'cloud_api',
    asrProvider: 'qwen',
    aiProvider: 'openai_compat',
    aiModel: 'gpt-4o-mini',
    aiStatus: 'skipped',
  },
  {
    id: 'history-empty-failed',
    timestamp: now - 2 * 24 * 60 * 60 * 1000,
    asrText: '',
    llmText: '',
    asrMs: 1200,
    llmMs: 0,
    durationSec: 6.8,
    charCount: 0,
    isEmpty: true,
    failReasonCode: 'provider_rate_limit',
    workMode: 'server',
    asrProvider: 'server',
    aiStatus: 'failed',
  },
]

const EMPTY_WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQAAAAA='

const meta = {
  title: 'components/history/HistoryRecordList',
  component: HistoryRecordList,
  parameters: {
    layout: 'padded',
    tauri: {
      commands: {
        append_debug_log: () => undefined,
        copy_text: () => undefined,
        audio_file_exists: () => true,
        read_audio_file: () => EMPTY_WAV_BASE64,
        save_audio_to_downloads: () => 'C:\\Users\\Storybook\\Downloads\\sayit-demo.wav',
        reveal_file_in_folder: () => undefined,
        get_client_runtime_info: () => ({
          userId: 'storybook-user',
          userName: 'Storybook',
          deviceId: 'storybook-device',
          hostname: 'storybook-host',
          clientVersion: '0.0.0',
          platform: 'windows',
          osVersion: 'storybook',
          localIp: '',
          systemLocale: 'en-US',
          cpuCores: 4,
          memoryMb: 8192,
        }),
      },
      settings: {
        asrCorrectionConsentVersion: '',
      },
    },
  },
} satisfies Meta<typeof HistoryRecordList>

export default meta
type Story = StoryObj<typeof meta>

const callbacks = {
  onDelete: () => undefined,
  onToggleFavorite: () => undefined,
  onReprocess: () => undefined,
  onEdit: () => undefined,
  onSaveAsrCorrection: () => undefined,
}

function crossMonthRecord(id: string, timestamp: number, asrText: string): HistoryRecord {
  return {
    id,
    timestamp,
    asrText,
    llmText: asrText,
    asrMs: 480,
    llmMs: 0,
    durationSec: 2.4,
    charCount: asrText.length,
    workMode: 'cloud_api',
    asrProvider: 'deepgram',
  }
}

// Fixed dates keep the headings stable and pin the month-boundary order.
const crossMonthRecords = [
  crossMonthRecord('history-october', new Date(2026, 9, 13, 12).getTime(), 'Newest October note'),
  crossMonthRecord('history-september', new Date(2026, 8, 30, 12).getTime(), 'Older September note'),
  crossMonthRecord('history-august', new Date(2026, 7, 18, 12).getTime(), 'Oldest August note'),
]

export const RichHistory: Story = {
  args: {
    records,
    ...callbacks,
    highlight: 'release',
  },
}

export const CrossMonthDayGroups: Story = {
  args: {
    records: crossMonthRecords,
    ...callbacks,
  },
}

export const EmptyHistory: Story = {
  args: {
    records: [],
    onDelete: () => undefined,
  },
}

export const ReprocessFailure: Story = {
  args: {
    records: [records[0]],
    onDelete: () => undefined,
    onReprocess: () => Promise.reject('sayit_error:server_timeout:Retranscription timed out'),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole('button', { name: t('record.details') }))
    await userEvent.click(await canvas.findByRole('button', { name: t('record.reprocess') }))
    await expect(await canvas.findByRole('alert')).toHaveTextContent(
      t('record.reprocessFailed', { reason: 'Retranscription timed out' }),
    )
  },
}

import type { Meta, StoryObj } from '@storybook/react-vite'
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
    promptPresetName: 'Intent cleanup',
    autoAppliedHotwords: ['release notes', 'deploy'],
    manualEditedAt: now - 10 * 60 * 1000,
  },
  {
    id: 'history-cloud-skipped',
    timestamp: now - 26 * 60 * 60 * 1000,
    asrText: 'The cloud provider returned the transcript without cleanup.',
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

export const RichHistory: Story = {
  args: {
    records,
    ...callbacks,
    highlight: 'release',
  },
}

export const EmptyHistory: Story = {
  args: {
    records: [],
    onDelete: () => undefined,
  },
}

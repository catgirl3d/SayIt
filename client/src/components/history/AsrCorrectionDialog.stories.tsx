import type { Meta, StoryObj } from '@storybook/react-vite'
import { ASR_CORRECTION_CONSENT_VERSION } from '@/services/asrCorrection'
import type { HistoryRecord } from '@/services/store'
import { AsrCorrectionDialog } from './AsrCorrectionDialog'

const AUDIO_PATH = 'C:\\recordings\\storybook-correction.wav'
const MISSING_AUDIO_PATH = 'C:\\recordings\\missing-correction.wav'
const EMPTY_WAV_BASE64 = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAESsAAABAAgAZGF0YQAAAAA='

const correctionRecord: HistoryRecord = {
  id: 'history-correction-1',
  timestamp: Date.now(),
  asrText: 'The deploy is ready for review tomorrow',
  llmText: 'The deploy is ready for review tomorrow.',
  asrMs: 420,
  llmMs: 0,
  durationSec: 3.2,
  audioDurationSec: 3.1,
  charCount: 45,
  audioFilePath: AUDIO_PATH,
  workMode: 'server',
  asrProvider: 'server',
}

const meta = {
  title: 'components/history/AsrCorrectionDialog',
  component: AsrCorrectionDialog,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      commands: {
        audio_file_exists: (args: { filePath?: string }) => args?.filePath !== MISSING_AUDIO_PATH,
        read_audio_file: () => EMPTY_WAV_BASE64,
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
    },
  },
} satisfies Meta<typeof AsrCorrectionDialog>

export default meta
type Story = StoryObj<typeof meta>

const dialogCallbacks = {
  onClose: () => undefined,
  onSubmitted: () => undefined,
}

export const ConsentRequired: Story = {
  args: {
    record: correctionRecord,
    ...dialogCallbacks,
  },
  parameters: {
    tauri: {
      settings: {
        asrCorrectionConsentVersion: '',
      },
    },
  },
}

export const AudioMissing: Story = {
  args: {
    record: { ...correctionRecord, audioFilePath: MISSING_AUDIO_PATH },
    ...dialogCallbacks,
  },
  parameters: {
    tauri: {
      settings: {
        asrCorrectionConsentVersion: '',
      },
    },
  },
}

export const Submitted: Story = {
  args: {
    record: {
      ...correctionRecord,
      asrCorrectionId: 'c-history-correction-1',
      asrCorrectionSubmittedAt: Date.now(),
      asrCorrectedText: 'The deployment is ready for review tomorrow.',
    },
    ...dialogCallbacks,
  },
  parameters: {
    tauri: {
      settings: {
        asrCorrectionConsentVersion: ASR_CORRECTION_CONSENT_VERSION,
      },
    },
  },
}

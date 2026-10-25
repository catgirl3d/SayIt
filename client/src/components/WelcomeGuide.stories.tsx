import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { emit } from '@tauri-apps/api/event'
import { getSetting } from '@/services/store'
import { getWorkMode, switchProvider, type WorkMode } from '@/services/transcription'
import { initRuntimeConfig, resetBackendBaseUrl } from '@/services/runtimeConfig'
import {
  availableModels,
  diagnosticsWithGpu,
  downloadedModels,
  primaryModelId,
} from '@/storybook/localModelFixtures'
import WelcomeGuide from './WelcomeGuide'

let previousWelcomeGuideMode: WorkMode | undefined
let downloadedForStory: typeof downloadedModels = []
let downloadStarted = false
let finishDownload: (() => void) | undefined
const serverHealthStub = fn(() => new Response(
  JSON.stringify({ status: 'ok', asr: true, llm: true }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
))

const localModelCommands = {
  list_available_models: () => availableModels,
  list_downloaded_models: () => downloadedModels,
  gguf_asr_diagnostics: () => diagnosticsWithGpu,
}

const meta = {
  title: 'components/WelcomeGuide',
  component: WelcomeGuide,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      commands: {
        shortcuts_changed: () => undefined,
        append_debug_log: () => undefined,
        unload_local_model: () => undefined,
        wait_for_backend_tls_ready: () => undefined,
        doubao_stream_close: () => undefined,
        qwen_stream_close: () => undefined,
        qwen_audio_stream_close: () => undefined,
        deepgram_stream_close: () => undefined,
        usage_summary: () => ({
          takes: 0,
          totalChars: 0,
          totalDurationSec: 0,
          datedTakes: 0,
          datedChars: 0,
          maxDurationSec: 0,
          activeDays: 0,
          hourBuckets: Array.from({ length: 24 }, () => 0),
          apps: [],
          workModes: [],
          promptPresets: [],
          firstUsedAt: null,
          lastUsedAt: null,
        }),
        ...localModelCommands,
      },
      settings: {
        shortcutHandsFree: 'AltRight',
        shortcutPTT: 'ControlRight',
        workMode: 'local',
        'localAsr.modelId': primaryModelId,
        'localAsr.downloadSource': 'HuggingFace',
      },
    },
  },
  beforeEach: async () => {
    const previousMode = getWorkMode()
    previousWelcomeGuideMode = previousMode
    if (previousMode !== 'local') await switchProvider('local')
  },
  afterEach: async () => {
    if (previousWelcomeGuideMode && getWorkMode() !== previousWelcomeGuideMode) {
      await switchProvider(previousWelcomeGuideMode as WorkMode)
    }
    previousWelcomeGuideMode = undefined
  },
} satisfies Meta<typeof WelcomeGuide>

export default meta
type Story = StoryObj<typeof meta>

async function goToStep(canvasElement: HTMLElement, target: number) {
  const canvas = within(canvasElement)
  for (let step = 0; step < target; step += 1) {
    await userEvent.click(await canvas.findByRole('button', { name: 'Next' }))
  }
}

export const FirstStep: Story = {
  args: {
    onComplete: () => undefined,
  },
}

export const ModeStepLocalNoModel: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      commands: {
        list_downloaded_models: () => [],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 3)
    const canvas = within(canvasElement)
    await expect(await canvas.findByText('Choose where speech is recognized')).toBeVisible()
    await expect(await canvas.findByRole('button', { name: 'Download' })).toBeVisible()
  },
}

export const ModeStepLocalReady: Story = {
  args: {
    onComplete: () => undefined,
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 3)
    const canvas = within(canvasElement)
    await expect(await canvas.findByText('Choose where speech is recognized')).toBeVisible()
    await expect((await canvas.findAllByText('Ready', { exact: true })).length).toBeGreaterThan(0)
  },
}

export const ModeStepCloudApi: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      settings: {
        workMode: 'cloud_api',
        'cloudAsr.profiles': [],
        'cloudAsr.activeProfileId': '',
      },
    },
  },
  beforeEach: async () => {
    if (getWorkMode() !== 'cloud_api') await switchProvider('cloud_api')
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 3)
    const canvas = within(canvasElement)
    await expect(await canvas.findByText('No speech recognition services configured. Click New to add one.')).toBeVisible()
  },
}

export const ModeStepCloudApiEditor: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      settings: {
        workMode: 'cloud_api',
        'cloudAsr.profiles': [],
        'cloudAsr.activeProfileId': '',
      },
    },
  },
  beforeEach: async () => {
    if (getWorkMode() !== 'cloud_api') await switchProvider('cloud_api')
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 3)
    const canvas = within(canvasElement)
    await userEvent.click(await canvas.findByRole('button', { name: 'New' }))

    const body = within(canvasElement.ownerDocument.body)
    const dialog = await body.findByRole('dialog')
    await expect(dialog).toBeVisible()
    await waitFor(() => {
      expect(document.activeElement).toBe(document.getElementById('asr-api-key'))
    })
  },
}

export const ModeStepServerEmpty: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      settings: {
        workMode: 'server',
      },
    },
  },
  beforeEach: async () => {
    await resetBackendBaseUrl()
    if (getWorkMode() !== 'server') await switchProvider('server')
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 3)
    const canvas = within(canvasElement)
    const input = await canvas.findByLabelText('Server address') as HTMLInputElement
    expect(input.value).toBe('')
  },
}

export const SwitchMode: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      settings: {
        'cloudAsr.profiles': [],
        'cloudAsr.activeProfileId': '',
      },
    },
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 3)
    const canvas = within(canvasElement)

    await userEvent.click(await canvas.findByRole('radio', { name: /Cloud API/ }))

    await waitFor(async () => {
      const stored = await getSetting<string>('workMode', '')
      if (stored !== 'cloud_api') throw new Error(`workMode was not saved: ${stored}`)
    })
    await expect(await canvas.findByText('No speech recognition services configured. Click New to add one.')).toBeVisible()
  },
}

export const TryStepLocalReady: Story = {
  args: {
    onComplete: () => undefined,
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 4)
    const canvas = within(canvasElement)
    await expect(await canvas.findByText('Try dictating', { exact: true })).toBeVisible()
    expect(canvas.getByRole('textbox')).not.toHaveAttribute('readonly')
  },
}

export const TryStepNotReady: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      commands: {
        list_downloaded_models: () => [],
      },
    },
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 4)
    const canvas = within(canvasElement)
    await expect(await canvas.findByText('Voice test', { exact: true })).toBeVisible()
    const setup = await canvas.findAllByText('Setup needed')
    await expect(setup.some((node) => node.closest('[hidden]') === null)).toBe(true)
    const textarea = await canvas.findByPlaceholderText('Finish setting up the selected mode on the previous step to test dictation here. You can also do it later in Settings → Voice engine.')
    expect(textarea).toHaveAttribute('readonly')
  },
}

export const ServerModeHealthy: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      settings: {
        workMode: 'server',
        backendBaseUrl: 'https://server.example',
      },
    },
    network: {
      'https://server.example/healthz': serverHealthStub,
    },
  },
  beforeEach: async () => {
    serverHealthStub.mockClear()
    if (getWorkMode() !== 'server') await switchProvider('server')
    await initRuntimeConfig()
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 4)
    await waitFor(() => expect(serverHealthStub).toHaveBeenCalledTimes(1))

    const canvas = within(canvasElement)
    const serverMode = await canvas.findAllByText('Server mode', { exact: true })
    await expect(serverMode.some((node) => node.closest('[hidden]') === null)).toBe(true)
    const connected = await canvas.findAllByText('Connected', { exact: true })
    await expect(connected.some((node) => node.closest('[hidden]') === null)).toBe(true)
  },
}

export const DownloadContinuesAcrossSteps: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      commands: {
        list_downloaded_models: () => downloadedForStory,
        download_model: () => {
          downloadStarted = true
          return new Promise<void>((resolve) => { finishDownload = resolve })
        },
        preload_local_model: () => undefined,
      },
      settings: {
        workMode: 'local',
        'localAsr.modelId': '',
        'localAsr.downloadSource': 'HuggingFace',
      },
    },
  },
  beforeEach: () => {
    downloadedForStory = []
    downloadStarted = false
    finishDownload = undefined
  },
  play: async ({ canvasElement }) => {
    await goToStep(canvasElement, 3)
    const canvas = within(canvasElement)
    const downloadButton = await canvas.findByRole('button', { name: 'Download' })

    await userEvent.click(downloadButton)
    await waitFor(() => expect(downloadStarted).toBe(true))

    await userEvent.click(await canvas.findByRole('button', { name: 'Next' }))
    await expect(await canvas.findByText('Voice test', { exact: true })).toBeVisible()
    expect(downloadButton.isConnected).toBe(true)
    await expect(canvas.getByRole('textbox')).toHaveAttribute('readonly')
    expect(await getSetting<string>('localAsr.modelId', '')).not.toBe(primaryModelId)

    downloadedForStory = downloadedModels
    await emit('model-download-progress', {
      model_id: primaryModelId,
      file_name: 'nemotron-asr-streaming-0.6b-Q4_K_M.gguf',
      downloaded_bytes: 520 * 1024 * 1024,
      total_bytes: 520 * 1024 * 1024,
      percent: 100,
      status: 'completed',
    })
    finishDownload?.()

    await waitFor(() => {
      expect(canvas.getByRole('textbox')).not.toHaveAttribute('readonly')
    })
    await waitFor(async () => {
      const stored = await getSetting<string>('localAsr.modelId', '')
      if (stored !== primaryModelId) throw new Error(`model was not activated: ${stored}`)
    })
    await waitFor(() => {
      const ready = canvas.getAllByText('Ready', { exact: true })
      expect(ready.some((node) => node.closest('[hidden]') === null)).toBe(true)
    })
  },
}

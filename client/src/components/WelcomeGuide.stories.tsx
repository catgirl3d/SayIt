import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { getWorkMode, switchProvider, type WorkMode } from '@/services/transcription'
import { initRuntimeConfig } from '@/services/runtimeConfig'
import WelcomeGuide from './WelcomeGuide'

let previousWelcomeGuideMode: WorkMode | undefined
const serverHealthStub = fn(() => new Response(
  JSON.stringify({ status: 'ok', asr: true, llm: true }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
))

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
      },
      settings: {
        shortcutHandsFree: 'AltRight',
        shortcutPTT: 'ControlRight',
        workMode: 'local',
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

export const FirstStep: Story = {
  args: {
    onComplete: () => undefined,
  },
}

export const ServerModeHealthy: Story = {
  args: {
    onComplete: () => undefined,
  },
  parameters: {
    tauri: {
      settings: {
        shortcutHandsFree: 'AltRight',
        shortcutPTT: 'ControlRight',
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
    await waitFor(() => expect(serverHealthStub).toHaveBeenCalledTimes(1))

    const canvas = within(canvasElement)
    for (let step = 0; step < 3; step += 1) {
      await userEvent.click(await canvas.findByRole('button', { name: 'Next' }))
    }

    await expect(await canvas.findByText('Server mode', { exact: true })).toBeVisible()
    await expect(await canvas.findByText('Connected', { exact: true })).toBeVisible()
  },
}

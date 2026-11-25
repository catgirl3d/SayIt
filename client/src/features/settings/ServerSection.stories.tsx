import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { initRuntimeConfig, resetBackendBaseUrl, setBackendBaseUrl } from '@/services/runtimeConfig'
import { getTauriJournal } from '@/storybook/tauriMock'
import ServerSection from './ServerSection'

function makeHealthProbe() {
  return fn((_request: Request) => new Response(
    JSON.stringify({ asr: true, llm: true }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ))
}

const healthProbe = makeHealthProbe()
const legacyHealthProbe = makeHealthProbe()

const meta = {
  title: 'settings/ServerSection',
  component: ServerSection,
  parameters: {
    tauri: {
      commands: {
        append_debug_log: () => undefined,
        list_downloaded_models: () => [],
        wait_for_backend_tls_ready: () => undefined,
      },
    },
  },
  afterEach: async () => {
    await resetBackendBaseUrl()
  },
} satisfies Meta<typeof ServerSection>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {
  args: { speechLanguage: 'en' },
  parameters: {
    tauri: {
      settings: {
        backendBaseUrl: 'https://server.example',
      },
    },
  },
  beforeEach: async () => {
    await initRuntimeConfig()
  },
}

export const UnsavedAddress: Story = {
  args: { speechLanguage: 'uk' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'http://localhost:8000')
  },
}

export const NoBuiltinDefaultEmpty: Story = {
  args: { speechLanguage: 'en' },
  beforeEach: async () => {
    await resetBackendBaseUrl()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole('textbox') as HTMLInputElement
    await expect(input).toHaveValue('')
    await expect(input.placeholder).toBe('https://your-server.example')
    await expect(canvas.queryByRole('button', { name: 'Clear address' })).toBeNull()
    await expect(canvas.queryByRole('button', { name: 'Restore default' })).toBeNull()
  },
}

export const LegacyAddressBlocked: Story = {
  args: { speechLanguage: 'en' },
  parameters: {
    network: {
      'https://sayitapp.site/healthz': legacyHealthProbe,
    },
  },
  beforeEach: async () => {
    await resetBackendBaseUrl()
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole('textbox')
    await userEvent.clear(input)
    await userEvent.type(input, 'https://sayitapp.site')
    await userEvent.click(await canvas.findByRole('button', { name: 'Save and test' }))

    await expect(await canvas.findByText(
      'This address belongs to the former SayIt trial server, which this fork does not run or control. Enter your own server address.',
    )).toBeVisible()
    await expect(input).toHaveValue('https://sayitapp.site')
    await expect(legacyHealthProbe).not.toHaveBeenCalled()
    expect(getTauriJournal().calls.some(({ command }) => command === 'store_set_backend_url')).toBe(false)
  },
}

export const NoBuiltinDefaultSaved: Story = {
  args: { speechLanguage: 'en' },
  parameters: {
    network: {
      'https://server.example/healthz': healthProbe,
    },
  },
  beforeEach: async () => {
    await setBackendBaseUrl('https://server.example')
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const input = canvas.getByRole('textbox') as HTMLInputElement
    await waitFor(() => expect(input).toHaveValue('https://server.example'))

    await userEvent.click(await canvas.findByRole('button', { name: 'Clear address' }))

    await waitFor(() => expect(input).toHaveValue(''))
    await expect(await canvas.findByText('Address cleared. Server mode needs an address to work.')).toBeVisible()
    await expect(healthProbe).not.toHaveBeenCalled()
  },
}

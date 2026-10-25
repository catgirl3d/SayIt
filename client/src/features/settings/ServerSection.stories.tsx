import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, fn, userEvent, waitFor, within } from 'storybook/test'
import { resetBackendBaseUrl, setBackendBaseUrl } from '@/services/runtimeConfig'
import ServerSection from './ServerSection'

const healthProbe = fn((_request: Request) => new Response(
  JSON.stringify({ asr: true, llm: true }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
))

const meta = {
  title: 'settings/ServerSection',
  component: ServerSection,
  parameters: {
    tauri: {
      commands: {
        append_debug_log: () => undefined,
        list_downloaded_models: () => [],
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

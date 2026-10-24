import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { useLocation } from 'react-router-dom'
import HotwordEngineNotices from './HotwordEngineNotices'
import type { AsrHotwordCapability } from '@/lib/asrModels'
import { HOTWORD_TOKEN_BUDGET } from '@/services/hotwords/budget'
import type { DictationHotwordEngine } from '@/services/hotwords/activeEngine'

const capabilities: Record<string, AsrHotwordCapability> = {
  server: { delivery: 'context', clientCap: null },
  local: { delivery: 'not_wired_up', clientCap: null },
  groq_whisper: { delivery: 'not_wired_up', clientCap: null },
  deepgram: { delivery: 'vocabulary', clientCap: null },
}

function cloudEngine(
  capabilityKey: string,
  providerLabel: string,
  deepgramKeytermsEnabled = false,
): DictationHotwordEngine {
  return { mode: 'cloud_api', capabilityKey, providerLabel, deepgramKeytermsEnabled }
}

function LocationProbe() {
  // A span, not <output>: <output> carries the implicit "status" role the stories query for.
  return <span data-testid="location">{useLocation().pathname}</span>
}

const meta = {
  title: 'components/HotwordEngineNotices',
  component: HotwordEngineNotices,
  args: {
    engine: { mode: 'server', capabilityKey: 'server', providerLabel: '', deepgramKeytermsEnabled: false },
    capabilities,
    hotwordTokens: 120,
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
        <LocationProbe />
      </div>
    ),
  ],
} satisfies Meta<typeof HotwordEngineNotices>

export default meta
type Story = StoryObj<typeof meta>

export const CloudEngineIgnoresHotwords: Story = {
  args: { engine: cloudEngine('groq_whisper', 'Groq Whisper') },
  play: async ({ canvasElement }) => {
    const notice = within(canvasElement).getByRole('status')

    await expect(notice).toHaveTextContent('Groq Whisper does not send hotwords to speech recognition')
    await expect(notice).toHaveTextContent('Send hotwords to the AI prompt')
    await expect(notice).toHaveTextContent('AI processing')
  },
}

export const LocalEngineIgnoresHotwords: Story = {
  args: { engine: { mode: 'local', capabilityKey: 'local', providerLabel: '', deepgramKeytermsEnabled: false } },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent('Local mode does not send hotwords')
  },
}

export const DeepgramOptInOff: Story = {
  args: { engine: cloudEngine('deepgram', 'Deepgram') },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(canvas.getByRole('status')).toHaveTextContent('Hotwords are not sent to Deepgram')
    await expect(canvas.getByRole('status')).toHaveTextContent('Send dictionary terms to Deepgram')
    await userEvent.click(canvas.getByRole('button', { name: 'Open voice engine settings' }))
    await waitFor(() => expect(canvas.getByTestId('location')).toHaveTextContent('/voice-engine'))
  },
}

export const DeepgramOverTokenBudget: Story = {
  args: { engine: cloudEngine('deepgram', 'Deepgram', true), hotwordTokens: HOTWORD_TOKEN_BUDGET + 100 },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByRole('status')).toHaveTextContent(
      `exceed the Deepgram limit (${HOTWORD_TOKEN_BUDGET})`,
    )
  },
}

export const DeepgramSendsHotwords: Story = {
  args: { engine: cloudEngine('deepgram', 'Deepgram', true), hotwordTokens: HOTWORD_TOKEN_BUDGET },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('status')).toBeNull()
  },
}

export const ServerSendsHotwords: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('status')).toBeNull()
  },
}

export const EngineNotResolved: Story = {
  args: { engine: null },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('status')).toBeNull()
  },
}

export const CapabilityMatrixNotLoaded: Story = {
  args: { engine: cloudEngine('groq_whisper', 'Groq Whisper'), capabilities: {} },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('status')).toBeNull()
  },
}

export const EngineUnknownToTheMatrix: Story = {
  args: { engine: cloudEngine('future_provider', 'Future provider') },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).queryByRole('status')).toBeNull()
  },
}

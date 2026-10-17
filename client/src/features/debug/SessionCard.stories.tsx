import type { Meta, StoryObj } from '@storybook/react-vite'
import SessionCard from './SessionCard'
import type { DebugSession } from '@/services/debugLog'

const now = Date.now()

const completedSession: DebugSession = {
  id: 'storybook-session-card',
  startTime: now - 8_000,
  endTime: now - 5_000,
  systemPrompt: 'Clean up the spoken transcript without changing its meaning.',
  sampleRate: 16_000,
  messages: [
    { time: now - 7_900, direction: 'sent', type: 'start', data: { system_prompt: 'Clean up the spoken transcript.' } },
    { time: now - 7_700, direction: 'received', type: 'ready', data: { connection_id: 'storybook-connection', asr: true, llm: true } },
    { time: now - 6_500, direction: 'received', type: 'asr', data: { text: 'The session card keeps useful diagnostics.', asr_ms: 300, duration_sec: 1.6 } },
    {
      time: now - 5_800,
      direction: 'received',
      type: 'final',
      data: {
        asr_text: 'The session card keeps useful diagnostics.',
        llm_text: 'The session card keeps useful diagnostics.',
        asr_ms: 300,
        llm_ms: 150,
        duration_sec: 1.6,
        llm_debug: {
          provider: 'openai_compat',
          messages: [
            { role: 'system', content: 'Clean up the spoken transcript without changing its meaning.' },
            { role: 'user', content: 'The session card keeps useful diagnostics.' },
          ],
          raw_output: 'The session card keeps useful diagnostics.',
        },
      },
    },
    { time: now - 5_700, direction: 'received', type: 'done', data: {} },
  ],
  audioChunks: [new Int16Array([0, 1024, -1024, 512, -512, 0]).buffer],
}

const noResultSession: DebugSession = {
  id: 'storybook-session-card-empty',
  startTime: now - 2_000,
  messages: [{ time: now - 1_900, direction: 'received', type: 'ready', data: { connection_id: 'storybook-connection', asr: true, llm: false } }],
  audioChunks: [],
}

const meta = {
  title: 'features/debug/SessionCard',
  component: SessionCard,
} satisfies Meta<typeof SessionCard>

export default meta
type Story = StoryObj<typeof meta>

export const CompletedExpanded: Story = {
  args: {
    session: completedSession,
    defaultOpen: true,
  },
}

export const NoResultCollapsed: Story = {
  args: {
    session: noResultSession,
    defaultOpen: false,
  },
}

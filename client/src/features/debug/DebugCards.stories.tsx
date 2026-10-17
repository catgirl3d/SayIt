import type { Meta, StoryObj } from '@storybook/react-vite'
import {
  AudioPlayer,
  IssueRuntimeEventsCard,
  LogItem,
  PTTTimelineCard,
} from './DebugCards'
import { buildPTTHoldPairs } from './debugUtils'
import type { DebugMessage, DebugSession, RuntimeEvent } from '@/services/debugLog'
import type { PTTTimelineEvent } from './types'

const now = Date.now()

const timelineEvents: PTTTimelineEvent[] = [
  {
    time: now - 1_800,
    kind: 'down',
    source: 'webview_fallback',
    reason: 'all_members_down',
    keycode: 163,
    pttSetting: 'ControlRight',
  },
  {
    time: now - 700,
    kind: 'up',
    source: 'webview_fallback',
    reason: 'member_up',
    keycode: 163,
    pttSetting: 'ControlRight',
  },
  {
    time: now - 300,
    kind: 'down',
    source: 'global_hook',
    reason: 'all_members_down',
    keycode: 163,
    pttSetting: 'ControlRight',
  },
]

const runtimeIssues: RuntimeEvent[] = [
  {
    time: now - 5_000,
    level: 'warn',
    source: 'websocket',
    message: 'Connection timed out (10s)',
    detail: { retryable: true },
  },
  {
    time: now - 3_000,
    level: 'error',
    source: 'recorder',
    message: 'External text insertion failed',
    detail: { strategy: 'wm_paste', reason: 'target_not_editable' },
  },
]

const session: DebugSession = {
  id: 'storybook-debug-session',
  startTime: now - 6_000,
  endTime: now - 4_000,
  systemPrompt: 'Clean up the spoken transcript without changing its meaning.',
  sampleRate: 16_000,
  messages: [
    { time: now - 5_900, direction: 'sent', type: 'start', data: { system_prompt: 'Clean up the spoken transcript.' } },
    { time: now - 5_700, direction: 'received', type: 'ready', data: { connection_id: 'storybook-connection', asr: true, llm: true } },
    { time: now - 5_000, direction: 'received', type: 'asr', data: { text: 'A short debug transcript.', asr_ms: 280, duration_sec: 1.1 } },
    {
      time: now - 4_700,
      direction: 'received',
      type: 'final',
      data: {
        asr_text: 'A short debug transcript.',
        llm_text: 'A short debug transcript.',
        asr_ms: 280,
        llm_ms: 120,
        duration_sec: 1.1,
        llm_debug: {
          provider: 'openai_compat',
          messages: [{ role: 'user', content: 'A short debug transcript.' }],
          raw_output: 'A short debug transcript.',
        },
      },
    },
    { time: now - 4_600, direction: 'received', type: 'done', data: {} },
  ],
  audioChunks: [new Int16Array([0, 1024, -1024, 512, -512, 0]).buffer],
}

const emptySession: DebugSession = {
  id: 'storybook-empty-session',
  startTime: now - 1_000,
  messages: [],
  audioChunks: [],
}

const logMessage: DebugMessage = {
  time: now - 2_000,
  direction: 'received',
  type: 'final',
  data: {
    asr_text: 'Expanded message payload.',
    llm_text: 'Expanded message payload.',
    asr_ms: 240,
    llm_ms: 110,
  },
}

const meta = {
  title: 'features/debug/DebugCards',
  component: IssueRuntimeEventsCard,
} satisfies Meta<typeof IssueRuntimeEventsCard>

export default meta
type Story = StoryObj<typeof meta>

export const TimelineWithDanglingHold: Story = {
  args: { events: [] },
  render: () => <PTTTimelineCard pttEvents={timelineEvents} holdPairs={buildPTTHoldPairs(timelineEvents)} />,
}

export const RuntimeIssues: Story = {
  args: {
    events: runtimeIssues,
  },
}

export const AudioWithPcm: Story = {
  args: { events: [] },
  render: () => <AudioPlayer session={session} />,
}

export const AudioUnavailable: Story = {
  args: { events: [] },
  render: () => <AudioPlayer session={emptySession} />,
}

export const ExpandedMessage: Story = {
  args: { events: [] },
  render: () => <LogItem msg={logMessage} />,
}

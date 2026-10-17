import type { Meta, StoryObj } from '@storybook/react-vite'
import DebugPage from '@/features/debug/DebugPage'
import {
  addAudioChunk,
  addMsg,
  addRuntimeEvent,
  clearRuntimeEvents,
  clearSessions,
  endSession,
  startSession,
} from '@/services/debugLog'

const meta = {
  title: 'pages/Debug',
  component: DebugPage,
  beforeEach: ({ parameters }) => {
    clearSessions()
    clearRuntimeEvents()

    if ((parameters as { debugSeed?: string }).debugSeed === 'rich') seedDebugState()

    return () => {
      clearSessions()
      clearRuntimeEvents()
    }
  },
} satisfies Meta<typeof DebugPage>

function seedDebugState() {
  const now = Date.now()
  startSession({ systemPrompt: 'Clean up the spoken transcript without changing its meaning.' })
  addMsg('sent', 'start', {
    system_prompt: 'Clean up the spoken transcript without changing its meaning.',
    client_meta: { platform: 'storybook', client_version: '0.0.0' },
  })
  addMsg('received', 'ready', { connection_id: 'storybook-connection', asr: true, llm: true })
  addAudioChunk(new Int16Array([0, 1024, -1024, 512, -512, 0]).buffer)
  addMsg('received', 'asr', {
    text: 'Review the streaming diagnostics before release.',
    asr_ms: 320,
    duration_sec: 1.2,
  })
  addMsg('received', 'final', {
    asr_text: 'Review the streaming diagnostics before release.',
    llm_text: 'Review the streaming diagnostics before release.',
    asr_ms: 320,
    llm_ms: 140,
    duration_sec: 1.2,
    llm_debug: {
      provider: 'openai_compat',
      messages: [
        { role: 'system', content: 'Clean up the spoken transcript without changing its meaning.' },
        { role: 'user', content: 'Review the streaming diagnostics before release.' },
      ],
      raw_output: 'Review the streaming diagnostics before release.',
    },
  })
  addMsg('received', 'done', {})
  endSession()

  addRuntimeEvent('warn', 'websocket', 'Connection timed out (10s)', { retryable: true })
  addRuntimeEvent('error', 'recorder', 'External text insertion failed', { strategy: 'wm_paste' })
  addRuntimeEvent('warn', 'ptt', 'event:down', {
    timestamp: now - 1_200,
    source: 'webview_fallback',
    reason: 'all_members_down',
    keycode: 163,
    pttSetting: 'ControlRight',
  })
  addRuntimeEvent('warn', 'ptt', 'event:up', {
    timestamp: now - 400,
    source: 'webview_fallback',
    reason: 'member_up',
    keycode: 163,
    pttSetting: 'ControlRight',
  })
}

export default meta
type Story = StoryObj<typeof meta>

export const Empty: Story = {
  parameters: {
    tauri: {
      settings: {},
    },
  },
}

export const WithSessionsAndIssues: Story = {
  parameters: {
    debugSeed: 'rich',
    tauri: {
      commands: {
        append_debug_log: () => undefined,
      },
      settings: {},
    },
  },
}

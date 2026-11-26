import type { Meta, StoryObj } from '@storybook/react-vite'
import { emit } from '@tauri-apps/api/event'
import { expect, waitFor } from 'storybook/test'
import { getTauriJournal } from '@/storybook/tauriMock'
import Overlay from './Overlay'

const meta = {
  title: 'overlay/Overlay',
  component: Overlay,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      commands: {
        overlay_ready: () => undefined,
        overlay_render_ack: () => undefined,
        hide_overlay: () => undefined,
        set_escape_action_mode: () => undefined,
        copy_text: () => undefined,
      },
    },
  },
} satisfies Meta<typeof Overlay>

export default meta
type Story = StoryObj<typeof meta>

const BARS = [12, 16, 9, 14, 18, 8, 11, 15, 10, 13, 17, 7, 12, 16, 9, 14, 18, 8, 11, 15, 10, 13, 17, 7]
const SHOW = { _overlayShowId: 1, _overlayGeneration: 0, _overlayProbe: false, animationsEnabled: true }

function Stage() {
  return (
    <div className="flex h-[220px] w-full items-end justify-center bg-black p-4">
      <Overlay />
    </div>
  )
}

async function emitState(payload: Record<string, unknown>) {
  await emit('overlay-state', payload)
}

async function waitUntilReady() {
  // overlay_ready is sent after the state listener is registered.
  await waitFor(() => {
    expect(getTauriJournal().calls.some(({ command }) => command === 'overlay_ready')).toBe(true)
  })
}

async function waitUntilListening(animationsEnabled = true) {
  await waitUntilReady()
  await emitState({
    state: 'listening',
    ...SHOW,
    animationsEnabled,
    bars: BARS,
    barCount: BARS.length,
    showDuration: true,
  })
  // Let the listening frame render: the last waveform frame is captured during it.
  await waitFor(() => {
    expect(document.querySelector('.overlay-pill-recording-listening')).not.toBeNull()
  })
}

export const RecordingWarning: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilListening()
    await emitState({
      state: 'listening',
      ...SHOW,
      bars: BARS,
      barCount: BARS.length,
      warning: 'Speak closer to the microphone',
      warningTone: 'warn',
      elapsedSec: 295,
      showDuration: true,
    })

    await waitFor(() => {
      expect(document.querySelector('.overlay-attention')?.textContent).toBe('Speak closer to the microphone')
    })
    await expect(document.querySelector('.overlay-breathe')).not.toBeNull()
  },
}

export const ProcessingProgress: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilListening()
    await emitState({ state: 'thinking', ...SHOW, elapsedSec: 10 })

    await waitFor(() => {
      expect(document.querySelector('.overlay-wave-collapse')).not.toBeNull()
    })
    await waitFor(() => {
      expect(document.querySelector('.overlay-pill-thinking')).not.toBeNull()
    })
    await expect(document.querySelector('.overlay-thinking-ring-progress')).not.toBeNull()
    await expect(document.querySelector('.overlay-thinking-ring')).not.toBeNull()
    await expect(document.querySelector('.sr-only')?.textContent).toBe('Processing')
    await expect(document.querySelector('.overlay-progress-estimate')).toBeNull()
    await expect(document.querySelector('.overlay-progress-sheen')).toBeNull()
    await expect(document.querySelector('.overlay-ai-sparkle')).toBeNull()
  },
}

export const ProcessingAi: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilListening()
    await emitState({ state: 'thinking', ...SHOW, thinkingAi: true, elapsedSec: 10 })

    await waitFor(() => {
      expect(document.querySelector('.overlay-ai-sparkle')).not.toBeNull()
    })
    await expect(document.querySelector('.overlay-ai-sparkle')?.getAttribute('aria-hidden')).toBe('true')
    await expect(document.querySelector('.sr-only')?.textContent).toBe('AI processing')
  },
}

export const ProcessingAiCleared: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilListening()
    await emitState({ state: 'thinking', ...SHOW, thinkingAi: true, elapsedSec: 10 })

    await waitFor(() => {
      expect(document.querySelector('.overlay-ai-sparkle')).not.toBeNull()
    })

    // Omitting the flag on a full thinking update means this run is not AI-processed.
    await emitState({ state: 'thinking', ...SHOW, elapsedSec: 10 })
    await waitFor(() => {
      expect(document.querySelector('.overlay-ai-sparkle')).toBeNull()
      expect(document.querySelector('.sr-only')?.textContent).toBe('Processing')
    })
  },
}

export const AnimationsOff: Story = {
  render: () => <Stage />,
  play: async () => {
    try {
      await waitUntilListening(false)
      await emitState({ state: 'thinking', ...SHOW, animationsEnabled: false, elapsedSec: 10 })

      await waitFor(() => {
        expect(document.querySelector('.overlay-pill-thinking')).not.toBeNull()
      })
      await expect(document.querySelector('.overlay-thinking-ring-progress')).not.toBeNull()
      await expect(document.querySelector('.overlay-thinking-ring')).not.toBeNull()
      await expect(document.querySelector('.overlay-wave-collapse')).toBeNull()
      await expect(document.querySelector('.overlay-progress-estimate')).toBeNull()
      await expect(document.querySelector('.overlay-progress-creep')).toBeNull()
      await expect(document.querySelector('.overlay-progress-sheen')).toBeNull()
      await expect(document.querySelector('.overlay-ai-sparkle')).toBeNull()
    } finally {
      // The smoke suite runs stories in one document; never leave motion off for the next one.
      document.documentElement.dataset.motion = 'on'
    }
  },
}

export const ProcessingAiAnimationsOff: Story = {
  render: () => <Stage />,
  play: async () => {
    try {
      await waitUntilListening(false)
      await emitState({ state: 'thinking', ...SHOW, animationsEnabled: false, thinkingAi: true, elapsedSec: 10 })

      await waitFor(() => {
        expect(document.querySelector('.overlay-thinking-ring')).not.toBeNull()
      })
      await waitFor(() => {
        expect(document.querySelector('.overlay-ai-sparkle')).not.toBeNull()
        expect(document.querySelector('.sr-only')?.textContent).toBe('AI processing')
      })
    } finally {
      // The smoke suite runs stories in one document; never leave motion off for the next one.
      document.documentElement.dataset.motion = 'on'
    }
  },
}

export const RecordingStart: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilReady()
    await emitState({ state: 'waiting', ...SHOW })

    await waitFor(() => {
      expect(document.querySelector('.overlay-pill-recording-waiting')).not.toBeNull()
    })
    await expect(document.querySelector('.overlay-pill-enter-circle')).not.toBeNull()

    await emitState({ state: 'listening', ...SHOW, bars: BARS, barCount: BARS.length })
    await waitFor(() => {
      expect(document.querySelector('.overlay-pill-recording-listening')).not.toBeNull()
    })
  },
}

export const ProcessingToNoSpeech: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilListening()
    await emitState({ state: 'thinking', ...SHOW, elapsedSec: 10 })
    await waitFor(() => {
      expect(document.querySelector('.overlay-thinking-ring')).not.toBeNull()
    })

    await emitState({ state: 'toast', ...SHOW, toastText: 'No speech detected', toastTone: 'warn' })
    await waitFor(() => {
      expect(document.querySelector('.overlay-pill-notice-from-circle')).not.toBeNull()
    })
    await expect(document.querySelector('.overlay-pill-thinking')).toBeNull()
    await expect(document.querySelector('.overlay-thinking-circle-leave')).not.toBeNull()
    await expect(document.querySelector('.overlay-notice-from-circle')?.textContent).toContain('No speech detected')
  },
}

export const ProcessingToNoSpeechAnimationsOff: Story = {
  render: () => <Stage />,
  play: async () => {
    try {
      await waitUntilListening(false)
      await emitState({ state: 'thinking', ...SHOW, animationsEnabled: false, elapsedSec: 10 })
      await waitFor(() => {
        expect(document.querySelector('.overlay-pill-thinking')).not.toBeNull()
      })

      await emitState({ state: 'toast', ...SHOW, animationsEnabled: false, toastText: 'No speech detected', toastTone: 'warn' })
      await waitFor(() => {
        expect(document.querySelector('.overlay-pill-notice-from-circle')).not.toBeNull()
      })
      await expect(document.querySelector('.overlay-thinking-circle')).toBeNull()
      await expect(document.querySelector('.overlay-preparing-ghost')).toBeNull()
      await expect(document.querySelector('.overlay-notice-content')?.textContent).toContain('No speech detected')
    } finally {
      // The smoke suite runs stories in one document; never leave motion off for the next one.
      document.documentElement.dataset.motion = 'on'
    }
  },
}

export const ProcessingExit: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilListening()
    await emitState({ state: 'thinking', ...SHOW, elapsedSec: 10 })
    await waitFor(() => {
      expect(document.querySelector('.overlay-thinking-ring')).not.toBeNull()
    })

    await emitState({ state: 'thinking', ...SHOW, elapsedSec: 10, exit: true })
    await waitFor(() => {
      expect(document.querySelector('.overlay-pill-exit-thinking')).not.toBeNull()
    })
  },
}

export const StartFailedFromCircle: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilReady()
    await emitState({ state: 'waiting', ...SHOW })
    await waitFor(() => {
      expect(document.querySelector('.overlay-pill-recording-waiting')).not.toBeNull()
    })

    await emitState({ state: 'error', ...SHOW, errorMessage: 'Recording could not start' })
    await waitFor(() => {
      expect(document.querySelector('.overlay-pill-notice-from-circle')).not.toBeNull()
    })
    await expect(document.querySelector('.overlay-pill-recording-waiting')).toBeNull()
    await expect(document.querySelector('.overlay-pill-exit-notice')).toBeNull()
  },
}

export const RecordingStartAnimationsOff: Story = {
  render: () => <Stage />,
  play: async () => {
    try {
      await waitUntilReady()
      await emitState({ state: 'waiting', ...SHOW, animationsEnabled: false })

      await waitFor(() => {
        expect(document.querySelector('.overlay-pill-recording-waiting')).not.toBeNull()
      })
      await expect(document.querySelector('.overlay-pill-enter-circle')).not.toBeNull()

      await emitState({ state: 'listening', ...SHOW, animationsEnabled: false, bars: BARS, barCount: BARS.length })
      await waitFor(() => {
        expect(document.querySelector('.overlay-pill-recording-listening')).not.toBeNull()
      })
    } finally {
      // The smoke suite runs stories in one document; never leave motion off for the next one.
      document.documentElement.dataset.motion = 'on'
    }
  },
}

export const HiddenBetweenShows: Story = {
  render: () => <Stage />,
  play: async () => {
    await waitUntilListening()
    await emit('overlay-hidden', { showId: 1 })
    await waitFor(() => {
      expect(document.querySelector('[data-overlay-content]')).toBeNull()
    })

    await emitState({ state: 'waiting', ...SHOW, _overlayShowId: 2 })
    await waitFor(() => {
      expect(document.querySelector('[data-overlay-content]')).not.toBeNull()
    })
  },
}

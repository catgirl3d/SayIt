import type { Meta, StoryObj } from '@storybook/react-vite'
import RecordingOrb from './RecordingOrb'

const meta = {
  title: 'pages/studio/RecordingOrb',
  component: RecordingOrb,
} satisfies Meta<typeof RecordingOrb>

export default meta
type Story = StoryObj<typeof meta>

const callbacks = {
  onStart: () => undefined,
  onStop: () => undefined,
}

export const Idle: Story = {
  args: {
    ...callbacks,
    state: 'idle',
    elapsed: 0,
    errorText: '',
    bars: [],
  },
}

export const Connecting: Story = {
  args: {
    ...callbacks,
    state: 'connecting',
    elapsed: 0,
    errorText: '',
    bars: [],
  },
}

export const Recording: Story = {
  args: {
    ...callbacks,
    state: 'recording',
    elapsed: 83,
    errorText: '',
    bars: [5, 12, 24, 16, 32, 18, 8, 26, 38, 22, 14, 30, 10, 20, 34, 17, 7, 25, 40, 18, 11, 28, 16, 33],
  },
}

export const Processing: Story = {
  args: {
    ...callbacks,
    state: 'processing',
    elapsed: 83,
    errorText: '',
    bars: [],
  },
}

export const Error: Story = {
  args: {
    ...callbacks,
    state: 'idle',
    elapsed: 0,
    errorText: 'Microphone permission was denied.',
    bars: [],
  },
}

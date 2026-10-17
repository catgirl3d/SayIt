import type { Meta, StoryObj } from '@storybook/react-vite'
import { SystemAudioControls } from '@/pages/SystemAudio'

const meta = {
  title: 'features/systemAudio/SystemAudioControls',
  component: SystemAudioControls,
} satisfies Meta<typeof SystemAudioControls>

export default meta
type Story = StoryObj<typeof meta>

const onAction = () => undefined

export const Idle: Story = {
  args: {
    state: 'idle',
    busy: false,
    onAction,
  },
}

export const Starting: Story = {
  args: {
    state: 'starting',
    busy: true,
    onAction,
  },
}

export const Listening: Story = {
  args: {
    state: 'listening',
    busy: false,
    onAction,
  },
}

export const Paused: Story = {
  args: {
    state: 'paused',
    busy: false,
    onAction,
  },
}

export const Error: Story = {
  args: {
    state: 'error',
    busy: false,
    onAction,
  },
}

export const Stopping: Story = {
  args: {
    state: 'stopping',
    busy: true,
    onAction,
  },
}

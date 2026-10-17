import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { AudioProgressBar } from './AudioProgressBar'
import type { RecordingPlayback } from './useRecordingPlayback'

const defaultPlayback: RecordingPlayback = {
  playing: false,
  loading: false,
  ready: true,
  currentTime: 0,
  duration: 180,
  playbackRate: 1,
  progress: 0,
  toggle: async () => undefined,
  seek: () => undefined,
  changeRate: () => undefined,
}

const meta = {
  title: 'components/history/AudioProgressBar',
  component: AudioProgressBar,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof AudioProgressBar>

export default meta
type Story = StoryObj<typeof meta>

function PlaybackCanvas({ initialTime, initialRate }: { initialTime: number; initialRate: number }) {
  const [currentTime, setCurrentTime] = useState(initialTime)
  const [playbackRate, setPlaybackRate] = useState(initialRate)
  const duration = 180
  const playback: RecordingPlayback = {
    playing: false,
    loading: false,
    ready: true,
    currentTime,
    duration,
    playbackRate,
    progress: Math.min(currentTime / duration, 1),
    toggle: async () => undefined,
    seek: setCurrentTime,
    changeRate: setPlaybackRate,
  }

  return <AudioProgressBar playback={playback} />
}

export const InProgress: Story = {
  args: { playback: defaultPlayback },
  render: () => <PlaybackCanvas initialTime={42} initialRate={1.5} />,
}

export const Completed: Story = {
  args: { playback: defaultPlayback },
  render: () => <PlaybackCanvas initialTime={180} initialRate={1} />,
}

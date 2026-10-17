import type { Meta, StoryObj } from '@storybook/react-vite'
import CopyButton from './CopyButton'

const meta = {
  title: 'components/CopyButton',
  component: CopyButton,
  parameters: {
    layout: 'centered',
    tauri: {
      commands: {
        copy_text: () => undefined,
      },
    },
  },
} satisfies Meta<typeof CopyButton>

export default meta
type Story = StoryObj<typeof meta>

export const Transcript: Story = {
  args: {
    text: 'Please review the release notes before tomorrow afternoon.',
  },
}

export const MultilineTranscript: Story = {
  args: {
    text: 'First, check the recording settings.\n\nThen, run one short dictation and verify the result.',
  },
}

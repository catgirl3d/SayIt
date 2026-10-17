import type { Meta, StoryObj } from '@storybook/react-vite'
import { Feedback, FormatHint } from './feedback'

const meta = {
  title: 'ui/feedback',
  component: Feedback,
} satisfies Meta<typeof Feedback>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    tone: 'success',
    message: 'Settings saved successfully.',
  },
}

export const ErrorWithDetail: Story = {
  args: {
    tone: 'error',
    message: 'The connection could not be completed.',
    detail: 'Check the endpoint and try again.',
    actions: [{ label: 'Retry', onClick: () => undefined }],
  },
}

export const WarningWithDisabledAction: Story = {
  args: {
    tone: 'warning',
    message: 'This setting will apply to the next session.',
    detail: 'The current session keeps its existing configuration.',
    actions: [{ label: 'Apply now', onClick: () => undefined, disabled: true }],
  },
}

export const Info: Story = {
  args: {
    tone: 'info',
    message: 'No changes are pending.',
  },
}

export const FormatHintStory: Story = {
  args: {
    tone: 'info',
    message: 'Format hint',
  },
  render: () => <FormatHint text="Use the complete URL, including https://." />,
}

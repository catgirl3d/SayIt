import type { Meta, StoryObj } from '@storybook/react-vite'
import { AsrDiffPreview } from './AsrDiffPreview'

const meta = {
  title: 'components/history/AsrDiffPreview',
  component: AsrDiffPreview,
  parameters: { layout: 'padded' },
} satisfies Meta<typeof AsrDiffPreview>

export default meta
type Story = StoryObj<typeof meta>

export const CorrectedRecognition: Story = {
  args: {
    original: 'The deploy is ready for reveiw tomorrow',
    corrected: 'The deployment is ready for review tomorrow.',
  },
}

export const NoChanges: Story = {
  args: {
    original: 'The recording is ready.',
    corrected: 'The recording is ready.',
  },
}

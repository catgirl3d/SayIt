import type { Meta, StoryObj } from '@storybook/react-vite'
import AlphaBadge from './AlphaBadge'

const meta = {
  title: 'components/AlphaBadge',
  component: AlphaBadge,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof AlphaBadge>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {},
}

export const HeadingSize: Story = {
  args: { className: 'text-sm' },
}

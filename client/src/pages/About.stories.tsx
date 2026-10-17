import type { Meta, StoryObj } from '@storybook/react-vite'
import About from './About'

const meta = {
  title: 'pages/About',
  component: About,
} satisfies Meta<typeof About>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {}

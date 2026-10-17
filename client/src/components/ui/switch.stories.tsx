import type { Meta, StoryObj } from '@storybook/react-vite'
import { Switch } from './switch'

const meta = {
  title: 'ui/switch',
  component: Switch,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Switch>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    checked: true,
    label: 'Save transcription history',
    onChange: () => undefined,
  },
}

export const Unchecked: Story = {
  args: {
    checked: false,
    label: 'Save transcription history',
    onChange: () => undefined,
  },
}

export const Disabled: Story = {
  args: {
    checked: true,
    disabled: true,
    label: 'Save transcription history',
    onChange: () => undefined,
  },
}

export const CompactNoAnimation: Story = {
  args: {
    checked: false,
    label: 'Use compact controls',
    size: 'sm',
    noAnimation: true,
    onChange: () => undefined,
  },
}

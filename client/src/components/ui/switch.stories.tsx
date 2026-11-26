import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { Switch } from './switch'

function getSwitchTrack(canvasElement: HTMLElement) {
  const track = within(canvasElement).getByRole('switch').querySelector('span.relative')
  if (!(track instanceof HTMLElement)) throw new Error('Switch track not found')
  return track
}

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

export const DarkChecked: Story = {
  globals: { theme: 'dark', locale: 'en' },
  args: {
    checked: true,
    label: 'Save transcription history',
    onChange: () => undefined,
  },
  play: async ({ canvasElement }) => {
    await expect(getSwitchTrack(canvasElement)).toHaveClass('bg-primary')
  },
}

export const DarkUnchecked: Story = {
  globals: { theme: 'dark', locale: 'en' },
  args: {
    checked: false,
    label: 'Save transcription history',
    onChange: () => undefined,
  },
  play: async ({ canvasElement }) => {
    await expect(getSwitchTrack(canvasElement)).toHaveClass('bg-muted', 'dark:bg-muted-foreground/35')
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

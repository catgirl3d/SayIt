import type { Meta, StoryObj } from '@storybook/react-vite'
import { Tooltip } from './tooltip'

const meta = {
  title: 'ui/tooltip',
  component: Tooltip,
  args: {
    content: 'Tooltip content',
    children: 'Trigger',
    forceVisible: true,
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Tooltip>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <Tooltip content="Open settings" forceVisible>
      <button type="button" className="rounded-md border border-border px-3 py-2 text-sm text-foreground">
        Settings
      </button>
    </Tooltip>
  ),
}

export const LightVariant: Story = {
  render: () => (
    <Tooltip
      variant="light"
      content="Choose a profile before starting transcription."
      forceVisible
    >
      <button
        type="button"
        aria-label="Show profile help"
        className="flex h-7 w-7 items-center justify-center rounded-full border border-border text-sm text-muted-foreground"
      >
        ?
      </button>
    </Tooltip>
  ),
}

export const LongContent: Story = {
  render: () => (
    <Tooltip
      variant="light"
      forceVisible
      content={
        <div className="space-y-2">
          <p className="font-medium">Model availability</p>
          <p>{'Downloaded models stay on this device.\nCloud profiles send audio to the selected provider.'}</p>
          <p>Changing the model applies to the next transcription session.</p>
        </div>
      }
    >
      <button type="button" className="rounded-md border border-border px-3 py-2 text-sm text-foreground">
        Model details
      </button>
    </Tooltip>
  ),
}

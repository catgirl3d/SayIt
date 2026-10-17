import type { Meta, StoryObj } from '@storybook/react-vite'
import { Slider } from './slider'

const meta = {
  title: 'ui/slider',
  component: Slider,
  args: {
    value: 0,
    min: 0,
    max: 1,
    step: 0.1,
    onChange: () => undefined,
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Slider>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-80 space-y-2">
      <div className="flex items-center justify-between">
        <label id="caption-length-label" className="text-sm font-medium">Maximum caption length</label>
        <span className="text-sm tabular-nums text-muted-foreground">4.5 seconds</span>
      </div>
      <Slider
        labelledBy="caption-length-label"
        value={4.5}
        min={3}
        max={6}
        step={0.5}
        valueText="4.5 seconds"
        onChange={() => undefined}
      />
    </div>
  ),
}

export const MinValue: Story = {
  render: () => (
    <div className="w-80 space-y-2">
      <div className="flex items-center justify-between">
        <label id="minimum-caption-label" className="text-sm font-medium">Maximum caption length</label>
        <span className="text-sm tabular-nums text-muted-foreground">3 seconds</span>
      </div>
      <Slider
        labelledBy="minimum-caption-label"
        value={3}
        min={3}
        max={6}
        step={0.5}
        valueText="3 seconds"
        onChange={() => undefined}
      />
    </div>
  ),
}

export const Disabled: Story = {
  render: () => (
    <div className="w-80 space-y-2">
      <div className="flex items-center justify-between">
        <label id="disabled-caption-label" className="text-sm font-medium">Maximum caption length</label>
        <span className="text-sm tabular-nums text-muted-foreground">4.5 seconds</span>
      </div>
      <Slider
        labelledBy="disabled-caption-label"
        value={4.5}
        min={3}
        max={6}
        step={0.5}
        valueText="4.5 seconds"
        disabled
        onChange={() => undefined}
      />
    </div>
  ),
}

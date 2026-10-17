import type { Meta, StoryObj } from '@storybook/react-vite'
import MicBoostControl from './MicBoostControl'

const meta = {
  title: 'settings/MicBoostControl',
  component: MicBoostControl,
} satisfies Meta<typeof MicBoostControl>

export default meta
type Story = StoryObj<typeof meta>

const baseArgs = {
  gain: 1,
  onChange: () => undefined,
  labelledBy: 'mic-boost-heading',
  animated: true,
} satisfies Parameters<typeof MicBoostControl>[0]

function renderControl(gain: number, animated = true) {
  return (
    <div className="w-full max-w-2xl rounded-lg border border-border bg-card p-5">
      <h2 id="mic-boost-heading" className="mb-4 text-sm font-medium">Microphone boost</h2>
      <MicBoostControl
        gain={gain}
        onChange={() => undefined}
        labelledBy="mic-boost-heading"
        animated={animated}
      />
    </div>
  )
}

export const Minimum: Story = {
  args: baseArgs,
  render: () => renderControl(1),
}

export const High: Story = {
  args: baseArgs,
  render: () => renderControl(5),
}

export const DistortionRisk: Story = {
  args: baseArgs,
  render: () => renderControl(20),
}

export const LoadingValues: Story = {
  args: baseArgs,
  render: () => renderControl(3, false),
}

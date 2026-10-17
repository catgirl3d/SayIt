import type { Meta, StoryObj } from '@storybook/react-vite'
import { Segmented } from './segmented'

const meta = {
  title: 'ui/segmented',
  component: Segmented,
  args: {
    value: 'balanced',
    options: [],
    onChange: () => undefined,
  },
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Segmented>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="space-y-2">
      <p id="processing-mode-label" className="text-sm font-medium">Processing mode</p>
      <Segmented
        labelledBy="processing-mode-label"
        value="balanced"
        options={[
          { value: 'fast', label: 'Fast' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'accurate', label: 'Accurate' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}

export const DisabledGroup: Story = {
  render: () => (
    <div className="space-y-2">
      <p id="disabled-mode-label" className="text-sm font-medium">Processing mode</p>
      <Segmented
        labelledBy="disabled-mode-label"
        value="balanced"
        disabled
        options={[
          { value: 'fast', label: 'Fast' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'accurate', label: 'Accurate' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}

export const DisabledOption: Story = {
  render: () => (
    <div className="space-y-2">
      <p id="language-label" className="text-sm font-medium">Recognition language</p>
      <Segmented
        labelledBy="language-label"
        value="auto"
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'en', label: 'English' },
          { value: 'uk', label: 'Ukrainian', disabled: true },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}

export const CompactNoAnimation: Story = {
  render: () => (
    <div className="space-y-2">
      <p id="retention-label" className="text-sm font-medium">Keep history</p>
      <Segmented
        labelledBy="retention-label"
        size="sm"
        animated={false}
        value={10}
        options={[
          { value: 3, label: '3 days' },
          { value: 10, label: '10 days' },
          { value: 30, label: '30 days' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}

import { useState } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, within } from 'storybook/test'
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const selected = canvas.getByRole('radio', { name: 'Balanced' })
    await expect(selected).toHaveAttribute('aria-checked', 'true')
    await expect(selected).toBeDisabled()
    // The selected background loses strength with the dimmed option text.
    const indicator = canvasElement.querySelector('.sliding-indicator')
    await expect(indicator).not.toBeNull()
    await expect(indicator).toHaveClass('bg-foreground/[0.04]')
    await expect(indicator).not.toHaveClass('bg-foreground/[0.08]')
  },
}

export const DisabledSelectedOption: Story = {
  render: () => (
    <div className="space-y-2">
      <p id="disabled-selected-language-label" className="text-sm font-medium">Recognition language</p>
      <Segmented
        labelledBy="disabled-selected-language-label"
        value="uk"
        options={[
          { value: 'auto', label: 'Auto' },
          { value: 'en', label: 'English' },
          { value: 'uk', label: 'Ukrainian', disabled: true },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const selected = canvas.getByRole('radio', { name: 'Ukrainian' })
    await expect(selected).toHaveAttribute('aria-checked', 'true')
    await expect(selected).toBeDisabled()
    await expect(selected).toBeVisible()
    const indicator = canvasElement.querySelector('.sliding-indicator')
    await expect(indicator).not.toBeNull()
    await expect(indicator).toHaveClass('bg-foreground/[0.04]')
    await expect(indicator).not.toHaveClass('bg-foreground/[0.08]')
  },
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

export const ExtraSmall: Story = {
  render: () => (
    <div className="space-y-2">
      <p id="wave-style-label" className="text-sm font-medium">Style</p>
      <Segmented
        labelledBy="wave-style-label"
        size="xs"
        value="gradient"
        options={[
          { value: 'solid', label: 'Solid' },
          { value: 'gradient', label: 'Gradient' },
        ]}
        onChange={() => undefined}
      />
    </div>
  ),
}

function ControlledSegmented() {
  const [value, setValue] = useState('balanced')
  return (
    <div className="space-y-2">
      <p id="selection-mode-label" className="text-sm font-medium">Processing mode</p>
      <Segmented
        labelledBy="selection-mode-label"
        value={value}
        options={[
          { value: 'fast', label: 'Fast' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'accurate', label: 'Accurate' },
        ]}
        onChange={setValue}
      />
    </div>
  )
}

export const SelectionFollowsClick: Story = {
  render: () => <ControlledSegmented />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await userEvent.click(canvas.getByRole('radio', { name: 'Accurate' }))

    await expect(canvas.getByRole('radio', { name: 'Accurate' })).toHaveAttribute('aria-checked', 'true')
    await expect(canvas.getByRole('radio', { name: 'Balanced' })).toHaveAttribute('aria-checked', 'false')
    await expect(canvasElement.querySelector('.sliding-indicator')).not.toBeNull()
  },
}

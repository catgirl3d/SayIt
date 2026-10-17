import type { Meta, StoryObj } from '@storybook/react-vite'
import { ComboShortcutInput, PTTShortcutInput } from './ShortcutInputs'

const meta = {
  title: 'settings/ShortcutInputs',
  component: ComboShortcutInput,
} satisfies Meta<typeof ComboShortcutInput>

export default meta
type Story = StoryObj<typeof meta>

const baseArgs = {
  value: '',
  onChange: () => undefined,
  label: 'Shortcut',
  description: 'Choose a shortcut.',
  comboOnly: true,
} satisfies Parameters<typeof ComboShortcutInput>[0]

function Inputs({ ptt, combo }: { ptt: string; combo: string }) {
  return (
    <div className="w-full max-w-2xl space-y-5 rounded-lg border border-border bg-card p-5">
      <PTTShortcutInput
        value={ptt}
        onChange={() => undefined}
        label="Push to talk"
        description="Hold this key while speaking."
      />
      <ComboShortcutInput
        value={combo}
        onChange={() => undefined}
        label="Toggle AI cleanup"
        description="Use a combination that is not already reserved."
        comboOnly
      />
    </div>
  )
}

export const Configured: Story = {
  args: baseArgs,
  render: () => <Inputs ptt="ControlRight" combo="Control+Shift+A" />,
}

export const Unset: Story = {
  args: baseArgs,
  render: () => <Inputs ptt="" combo="" />,
}

export const MiddleMouseShortcut: Story = {
  args: baseArgs,
  render: () => <Inputs ptt="MButton" combo="Alt+Shift+M" />,
}

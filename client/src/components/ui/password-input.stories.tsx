import type { Meta, StoryObj } from '@storybook/react-vite'
import { PasswordInput } from './password-input'

const inputClassName = 'w-full rounded-md border border-input-border bg-input-bg px-3 py-2 pr-8 text-sm text-foreground'

const meta = {
  title: 'ui/password-input',
  component: PasswordInput,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof PasswordInput>

export default meta
type Story = StoryObj<typeof meta>

export const Default: Story = {
  args: {
    id: 'storybook-api-key',
    label: 'API key',
    value: 'sk-storybook-example-key',
    onChange: () => undefined,
    className: inputClassName,
  },
  render: (args) => (
    <div className="w-full max-w-sm space-y-1">
      <label htmlFor={args.id} className="block text-sm text-muted-foreground">API key</label>
      <PasswordInput {...args} />
    </div>
  ),
}

export const Empty: Story = {
  args: {
    id: 'storybook-empty-key',
    label: 'API key',
    value: '',
    onChange: () => undefined,
    placeholder: 'Paste an API key',
    className: inputClassName,
  },
  render: (args) => (
    <div className="w-full max-w-sm space-y-1">
      <label htmlFor={args.id} className="block text-sm text-muted-foreground">API key</label>
      <PasswordInput {...args} />
    </div>
  ),
}

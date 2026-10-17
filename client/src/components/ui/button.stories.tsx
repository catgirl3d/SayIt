import type { Meta, StoryObj } from '@storybook/react-vite'
import { Button } from './button'
import { themeList } from '@/themes'

const appVersion = __APP_VERSION__

const meta = {
  title: 'ui/button',
  component: Button,
  parameters: {
    layout: 'centered',
  },
  args: {
    children: 'Say it',
  },
} satisfies Meta<typeof Button>

export default meta
type Story = StoryObj<typeof meta>

export const Variants: Story = {
  render: (args) => (
    <div className="flex flex-wrap items-center gap-3">
      {(['default', 'secondary', 'outline', 'ghost', 'destructive', 'link'] as const).map((variant) => (
        <Button key={variant} {...args} variant={variant}>
          {variant}
        </Button>
      ))}
      <span className="text-xs text-muted-foreground">v{appVersion}</span>
    </div>
  ),
}

export const Sizes: Story = {
  render: (args) => (
    <div className="flex items-center gap-3">
      {(['sm', 'default', 'lg'] as const).map((size) => (
        <Button key={size} {...args} size={size}>
          {size}
        </Button>
      ))}
      <span className="text-xs text-muted-foreground">{themeList.length} themes</span>
    </div>
  ),
}

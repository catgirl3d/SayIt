import type { Meta, StoryObj } from '@storybook/react-vite'
import AppSection from './AppSection'

const meta = {
  title: 'settings/AppSection',
  component: AppSection,
} satisfies Meta<typeof AppSection>

export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {
  args: {
    autoLaunch: true,
    onToggleAutoLaunch: () => undefined,
    autoCheckUpdate: true,
    onToggleAutoCheckUpdate: () => undefined,
  },
}

export const Disabled: Story = {
  args: {
    autoLaunch: false,
    onToggleAutoLaunch: () => undefined,
    autoCheckUpdate: false,
    onToggleAutoCheckUpdate: () => undefined,
  },
}

export const Loading: Story = {
  args: {
    autoLaunch: false,
    onToggleAutoLaunch: () => undefined,
    autoCheckUpdate: true,
    onToggleAutoCheckUpdate: () => undefined,
    ready: false,
    animate: false,
  },
}

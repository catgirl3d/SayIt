import type { Meta, StoryObj } from '@storybook/react-vite'
import HotwordPromptInjectToggle from './HotwordPromptInjectToggle'

const meta = {
  title: 'settings/HotwordPromptInjectToggle',
  component: HotwordPromptInjectToggle,
} satisfies Meta<typeof HotwordPromptInjectToggle>

export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {
  parameters: {
    tauri: { settings: { injectHotwordsToPrompt: true } },
  },
}

export const Disabled: Story = {
  parameters: {
    tauri: { settings: { injectHotwordsToPrompt: false } },
  },
}

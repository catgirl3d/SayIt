import type { Meta, StoryObj } from '@storybook/react-vite'
import AppearancePage from './AppearancePage'

const meta = {
  title: 'settings/AppearancePage',
  component: AppearancePage,
  parameters: {
    tauri: {
      settings: {
        overlayShowDuration: true,
        streamingDisplayEnabled: true,
        overlayWaveTheme: 'black-blue',
        overlayWidth: 'long',
      },
    },
  },
} satisfies Meta<typeof AppearancePage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

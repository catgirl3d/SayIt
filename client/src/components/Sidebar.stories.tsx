import type { Meta, StoryObj } from '@storybook/react-vite'
import Sidebar from './Sidebar'

const meta = {
  title: 'components/Sidebar',
  component: Sidebar,
  parameters: {
    layout: 'fullscreen',
    tauri: {
      settings: {
        workMode: 'server',
      },
    },
  },
} satisfies Meta<typeof Sidebar>

export default meta
type Story = StoryObj<typeof meta>

export const HistoryActive: Story = {
  parameters: {
    router: { initialEntries: ['/history'] },
  },
}

export const AudioSettingsActive: Story = {
  parameters: {
    router: { initialEntries: ['/audio'] },
  },
}

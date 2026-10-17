import type { Meta, StoryObj } from '@storybook/react-vite'
import ShortcutsSettingsPage from './ShortcutsSettingsPage'

const meta = {
  title: 'settings/ShortcutsSettingsPage',
  component: ShortcutsSettingsPage,
  parameters: {
    tauri: {
      settings: {
        shortcutPTT: 'ControlRight',
        shortcutHandsFree: 'AltRight',
        shortcutToggleAi: 'Control+Shift+A',
        presetShortcuts: {
          intent: 'Alt+1',
          faithful: 'Alt+2',
        },
      },
    },
  },
} satisfies Meta<typeof ShortcutsSettingsPage>

export default meta
type Story = StoryObj<typeof meta>

export const Configured: Story = {}

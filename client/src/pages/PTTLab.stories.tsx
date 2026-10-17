import type { Meta, StoryObj } from '@storybook/react-vite'
import PTTLab from './PTTLab'

const meta = {
  title: 'pages/PTTLab',
  component: PTTLab,
} satisfies Meta<typeof PTTLab>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {
  parameters: {
    tauri: {
      commands: {
        set_ptt_lab_config: () => undefined,
        set_escape_action_mode: () => undefined,
        hide_overlay: () => undefined,
        append_debug_log: () => undefined,
      },
      settings: {
        overlayWaveTheme: 'black-blue',
        overlayShowDuration: true,
        readySoundEnabled: false,
        overlayWidth: 'medium',
      },
    },
  },
}

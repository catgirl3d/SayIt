import type { Meta, StoryObj } from '@storybook/react-vite'
import DiagnosticsPage from './DiagnosticsPage'
import { diagnosticsPreviewFixture } from './diagnosticsPreviewFixture'

const meta = {
  title: 'settings/DiagnosticsPage',
  component: DiagnosticsPage,
  parameters: {
    tauri: {
      commands: {
        read_log_file: () => '[INFO] recorder ready\n[WARN] remote check took longer than expected',
        get_diagnostics_preview: () => diagnosticsPreviewFixture,
      },
      settings: {
        workMode: 'server',
        aiEnabled: false,
        'speechInput.language': 'en',
      },
    },
  },
} satisfies Meta<typeof DiagnosticsPage>

export default meta
type Story = StoryObj<typeof meta>

export const HealthyServer: Story = {}

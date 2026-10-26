import type { Meta, StoryObj } from '@storybook/react-vite'
import { initProviderFromStore } from '@/services/transcription'
import DiagnosticsPage from './DiagnosticsPage'
import { diagnosticsPreviewFixture } from './diagnosticsPreviewFixture'

const meta = {
  title: 'settings/DiagnosticsPage',
  component: DiagnosticsPage,
  beforeEach: async () => {
    await initProviderFromStore()
  },
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

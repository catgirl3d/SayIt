import type { Meta, StoryObj } from '@storybook/react-vite'
import DiagnosticsSection from './DiagnosticsSection'
import { diagnosticsPreviewFixture } from './diagnosticsPreviewFixture'

const meta = {
  title: 'settings/DiagnosticsSection',
  component: DiagnosticsSection,
  parameters: {
    layout: 'padded',
    tauri: {
      commands: { get_diagnostics_preview: () => diagnosticsPreviewFixture },
    },
  },
} satisfies Meta<typeof DiagnosticsSection>

export default meta
type Story = StoryObj<typeof meta>

export const EmbeddedReport: Story = {}

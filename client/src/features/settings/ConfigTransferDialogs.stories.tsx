import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ConfigImportPreview } from '@/services/backup'
import type { CustomTheme } from '@/services/hotwords/model'
import type { PromptPreset } from '@/services/store'
import type { TextReplacementRule } from '@/services/textReplacement'
import {
  ConfigExportDialog,
  ConfigImportDialog,
  FullImportConfirmDialog,
  ImportDoneDialog,
} from './ConfigTransferDialogs'

const customThemes: CustomTheme[] = [
  { id: 'storybook-engineering', name: 'Engineering', words: ['TypeScript', 'Tauri', 'Storybook', 'Vitest'] },
  { id: 'storybook-product', name: 'Product', words: ['roadmap', 'retention', 'experiment'] },
]

const replacementRules: TextReplacementRule[] = [
  { id: 'storybook-cloud-code', from: 'Cloud Code', to: 'Claude Code', enabled: true },
  { id: 'storybook-say-it', from: 'Say it', to: 'SayIt', enabled: true },
]

const customPresets: PromptPreset[] = [
  {
    id: 'storybook-meeting-notes',
    name: 'Meeting notes',
    systemPrompt: 'Turn the transcript into concise meeting notes with decisions and action items.',
  },
  {
    id: 'storybook-release-summary',
    name: 'Release summary',
    systemPrompt: 'Rewrite the transcript as a short release summary with concrete technical changes.',
  },
]

const transferSettings = {
  customHotwordThemes: customThemes,
  textReplacements: replacementRules,
  promptPresets: customPresets,
  'ai.builtinPromptLanguage': 'en',
}

const selectedPreview: ConfigImportPreview = {
  scope: 'selected',
  formatVersion: 2,
  importToken: 'storybook-import-token',
  requiresRestart: true,
  sections: [
    { kind: 'hotwords', total: 4, added: 2, updated: 1, skipped: 1 },
    { kind: 'textReplacements', total: 2, added: 1, updated: 1, skipped: 0 },
    { kind: 'promptPresets', total: 1, added: 1, updated: 0, skipped: 0 },
  ],
  warnings: [{ code: 'hotwordLimit', current: 120, limit: 100 }],
}

const fullPreview: ConfigImportPreview = {
  scope: 'full',
  formatVersion: 2,
  importToken: 'storybook-full-import-token',
  requiresRestart: true,
  sections: [
    { kind: 'fullConfig', total: 1, added: 0, updated: 1, skipped: 0 },
    { kind: 'hotwords', total: 4, added: 4, updated: 0, skipped: 0 },
    { kind: 'textReplacements', total: 2, added: 2, updated: 0, skipped: 0 },
    { kind: 'promptPresets', total: 2, added: 2, updated: 0, skipped: 0 },
  ],
  warnings: [{ code: 'fullOverwrite', current: null, limit: null }],
}

const meta = {
  title: 'settings/ConfigTransferDialogs',
  component: ConfigExportDialog,
  parameters: {
    layout: 'centered',
    tauri: { settings: transferSettings },
  },
} satisfies Meta<typeof ConfigExportDialog>

export default meta
type Story = StoryObj<typeof meta>

export const ExportReady: Story = {
  args: {
    onClose: () => undefined,
    onExport: () => undefined,
  },
}

export const SelectedExportReady: Story = {
  args: {
    onClose: () => undefined,
    onExport: () => undefined,
  },
  play: async () => {
    const body = document.body
    const selectedTab = Array.from(body.querySelectorAll('button')).find((button) => button.textContent === 'Selected items')
    if (!selectedTab) throw new Error('Selected-items export tab is missing')
    selectedTab.click()
  },
}

export const SelectedImportPreview: Story = {
  args: {
    onClose: () => undefined,
    onExport: () => undefined,
  },
  render: () => (
    <ConfigImportDialog
      filePath="C:\\Users\\Storybook\\Downloads\\sayit-selected.json"
      preview={selectedPreview}
      onClose={() => undefined}
      onConfirm={() => undefined}
    />
  ),
}

export const FullImportConfirmation: Story = {
  args: {
    onClose: () => undefined,
    onExport: () => undefined,
  },
  render: () => (
    <ConfigImportDialog
      filePath="C:\\Users\\Storybook\\Downloads\\sayit-settings.json"
      preview={fullPreview}
      onClose={() => undefined}
      onConfirm={() => undefined}
    />
  ),
}

export const FullDataImportConfirmation: Story = {
  args: {
    onClose: () => undefined,
    onExport: () => undefined,
  },
  render: () => (
    <FullImportConfirmDialog
      filePath="C:\\Users\\Storybook\\Downloads\\sayit-backup.zip"
      onClose={() => undefined}
      onConfirm={() => undefined}
    />
  ),
}

export const ImportCompleted: Story = {
  args: {
    onClose: () => undefined,
    onExport: () => undefined,
  },
  render: () => <ImportDoneDialog />,
}

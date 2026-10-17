import { fireEvent, waitFor } from '@testing-library/react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import type { ConfigImportPreview as ConfigImportPreviewData } from '@/services/backup'
import type { CustomTheme } from '@/services/hotwords/model'
import type { PromptPreset } from '@/services/store'
import type { TextReplacementRule } from '@/services/textReplacement'
import BackupSection from './BackupSection'

const customThemes: CustomTheme[] = [
  { id: 'storybook-engineering', name: 'Engineering', words: ['TypeScript', 'Tauri', 'Storybook'] },
]

const replacementRules: TextReplacementRule[] = [
  { id: 'storybook-cloud-code', from: 'Cloud Code', to: 'Claude Code', enabled: true },
]

const customPresets: PromptPreset[] = [{
  id: 'storybook-meeting-notes',
  name: 'Meeting notes',
  systemPrompt: 'Turn the transcript into concise meeting notes with decisions and action items.',
}]

const transferSettings = {
  customHotwordThemes: customThemes,
  textReplacements: replacementRules,
  promptPresets: customPresets,
  'ai.builtinPromptLanguage': 'en',
}

const importPreview: ConfigImportPreviewData = {
  scope: 'selected',
  formatVersion: 2,
  importToken: 'storybook-backup-token',
  requiresRestart: true,
  sections: [
    { kind: 'hotwords', total: 3, added: 2, updated: 1, skipped: 0 },
    { kind: 'textReplacements', total: 1, added: 1, updated: 0, skipped: 0 },
  ],
  warnings: [],
}

const baseCommands = {
  export_config: () => 'C:\\Users\\Storybook\\Documents\\sayit-settings.json',
  export_full: () => 'C:\\Users\\Storybook\\Documents\\sayit-all-data.zip',
  inspect_config_import: () => importPreview,
  import_config: () => ({ changedSections: ['hotwords'], added: 2, updated: 1, skipped: 0, requiresRestart: true }),
  import_full: () => undefined,
  restart_app: () => undefined,
  reveal_file_in_folder: () => undefined,
  'plugin:dialog|open': () => 'C:\\Users\\Storybook\\Downloads\\sayit-selected.json',
  append_debug_log: () => undefined,
}

const meta = {
  title: 'settings/BackupSection',
  component: BackupSection,
  parameters: {
    layout: 'padded',
    tauri: { commands: baseCommands, settings: transferSettings },
  },
} satisfies Meta<typeof BackupSection>

export default meta
type Story = StoryObj<typeof meta>

export const Ready: Story = {}

export const ConfigExportSuccess: Story = {
  play: async () => {
    const exportButtons = Array.from(document.body.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Export')
    if (exportButtons.length < 1) throw new Error('Settings export action is missing')
    fireEvent.click(exportButtons[0])

    await waitFor(() => {
      if (!document.body.textContent?.includes('Export settings')) throw new Error('Export settings dialog did not open')
    })
    const dialog = document.body.querySelector('[role="dialog"]')
    const dialogExport = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'Export')
    if (!(dialogExport instanceof HTMLButtonElement)) throw new Error('Dialog export action is missing')
    fireEvent.click(dialogExport)
    await waitFor(() => {
      if (!document.body.textContent?.includes('sayit-settings.json')) throw new Error('Exported settings path is missing')
    })
  },
}

export const ConfigExportError: Story = {
  parameters: {
    tauri: {
      commands: { ...baseCommands, export_config: () => { throw new Error('disk is full') } },
      settings: transferSettings,
    },
  },
  play: async () => {
    const exportButtons = Array.from(document.body.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Export')
    if (exportButtons.length < 1) throw new Error('Settings export action is missing')
    fireEvent.click(exportButtons[0])
    await waitFor(() => {
      if (!document.body.textContent?.includes('Export settings')) throw new Error('Export settings dialog did not open')
    })
    const dialog = document.body.querySelector('[role="dialog"]')
    const dialogExport = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) => button.textContent?.trim() === 'Export')
    if (!(dialogExport instanceof HTMLButtonElement)) throw new Error('Dialog export action is missing')
    fireEvent.click(dialogExport)
    await waitFor(() => {
      if (!document.body.textContent?.includes('Export failed: Error: disk is full')) throw new Error('Export error banner is missing')
    })
  },
}

export const ConfigImportPreview: Story = {
  play: async () => {
    const importButtons = Array.from(document.body.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Import')
    if (importButtons.length < 1) throw new Error('Settings import action is missing')
    fireEvent.click(importButtons[0])
    await waitFor(() => {
      if (!document.body.textContent?.includes('Import settings?')) throw new Error('Import preview dialog did not open')
      if (!document.body.textContent?.includes('Add 2')) throw new Error('Import preview summary is missing')
    })
  },
}

export const ConfigImportError: Story = {
  parameters: {
    tauri: {
      commands: {
        ...baseCommands,
        inspect_config_import: () => { throw new Error('invalid settings file') },
      },
      settings: transferSettings,
    },
  },
  play: async () => {
    const importButtons = Array.from(document.body.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Import')
    if (importButtons.length < 1) throw new Error('Settings import action is missing')
    fireEvent.click(importButtons[0])
    await waitFor(() => {
      if (!document.body.textContent?.includes('Import failed: Error: invalid settings file')) throw new Error('Import error banner is missing')
    })
  },
}

export const FullExportError: Story = {
  parameters: {
    tauri: {
      commands: { ...baseCommands, export_full: () => { throw new Error('archive unavailable') } },
      settings: transferSettings,
    },
  },
  play: async () => {
    const exportButtons = Array.from(document.body.querySelectorAll('button')).filter((button) => button.textContent?.trim() === 'Export')
    if (exportButtons.length < 2) throw new Error('All-data export action is missing')
    fireEvent.click(exportButtons[1])
    await waitFor(() => {
      if (!document.body.textContent?.includes('Export failed: Error: archive unavailable')) throw new Error('Full export error banner is missing')
    })
  },
}

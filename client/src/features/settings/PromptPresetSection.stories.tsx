import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, within } from 'storybook/test'
import { setAiEnabled } from '@/stores/aiEnabled'
import { getBuiltinPromptPresets, type PromptPreset } from '@/services/store'
import PromptPresetSection from './PromptPresetSection'

const builtins = getBuiltinPromptPresets('en')
const customPreset: PromptPreset = {
  id: 'storybook-meeting-notes',
  name: 'Meeting notes',
  systemPrompt: 'Turn spoken updates into concise meeting notes with owners, decisions, and action items.',
}
const presets = [...builtins.slice(0, 4), customPreset]
const presetShortcuts = {
  intent: 'Alt+1',
  faithful: 'Alt+2',
  translate_uk: 'Alt+3',
  'storybook-meeting-notes': 'Alt+4',
}

const callbacks = {
  onSelectPreset: () => undefined,
  onPromptLanguageChange: () => undefined,
  onStartNewPreset: () => undefined,
  onStartEditing: () => undefined,
  onEditingPresetChange: () => undefined,
  onEditingShortcutChange: () => undefined,
  onCancelEditing: () => undefined,
  onSavePreset: () => undefined,
  onDeletePreset: () => undefined,
  onMovePreset: () => undefined,
}

const aiCleanup = (enabled: boolean) => async () => {
  await setAiEnabled(enabled)
}

const meta = {
  title: 'settings/PromptPresetSection',
  component: PromptPresetSection,
  parameters: { tauri: { commands: { set_tray_ai_enabled: () => null } } },
  beforeEach: aiCleanup(true),
} satisfies Meta<typeof PromptPresetSection>

export default meta
type Story = StoryObj<typeof meta>

export const ConfiguredPresets: Story = {
  args: {
    presets,
    activePresetId: 'storybook-meeting-notes',
    editingPreset: null,
    presetShortcuts,
    editingShortcut: '',
    promptLanguage: 'en',
    ...callbacks,
  },
}

export const EditingCustomOverride: Story = {
  args: {
    presets,
    activePresetId: 'intent',
    editingPreset: { ...customPreset },
    presetShortcuts,
    editingShortcut: 'Alt+4',
    promptLanguage: 'uk',
    ...callbacks,
  },
}

export const EditingModifiedBuiltin: Story = {
  args: {
    presets,
    activePresetId: 'faithful',
    editingPreset: {
      ...builtins[1],
      systemPrompt: `${builtins[1].systemPrompt}\n\nKeep product names unchanged.`,
      builtinPromptModified: true,
      builtinPromptUpdateAvailable: true,
    },
    presetShortcuts,
    editingShortcut: 'Alt+2',
    promptLanguage: 'en',
    ...callbacks,
  },
}

export const AiCleanupOff: Story = {
  args: {
    presets,
    activePresetId: 'storybook-meeting-notes',
    editingPreset: null,
    presetShortcuts,
    editingShortcut: '',
    promptLanguage: 'en',
    ...callbacks,
  },
  beforeEach: aiCleanup(false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText(/presets aren't applied/i)).toBeVisible()
  },
}

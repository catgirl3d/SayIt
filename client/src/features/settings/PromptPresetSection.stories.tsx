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
const secondCustomPreset: PromptPreset = {
  id: 'storybook-email-replies',
  name: 'Email replies',
  systemPrompt: 'Turn spoken updates into concise email replies with a clear subject and closing.',
}
const presets = [...builtins.slice(0, 4), customPreset]
const sortablePresets = [...builtins.slice(0, 4), customPreset, secondCustomPreset]
const presetShortcuts = {
  intent: 'Alt+1',
  faithful: 'Alt+2',
  translate_uk: 'Alt+3',
  'storybook-meeting-notes': 'Alt+4',
}
const sortablePresetShortcuts = {
  ...presetShortcuts,
  'storybook-email-replies': 'Alt+5',
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

export const SortableCustomPresets: Story = {
  args: {
    presets: sortablePresets,
    activePresetId: 'storybook-meeting-notes',
    editingPreset: null,
    presetShortcuts: sortablePresetShortcuts,
    editingShortcut: '',
    promptLanguage: 'en',
    ...callbacks,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const handles = canvas.getAllByTestId('preset-drag-handle')

    expect(handles.length).toBe(2)
    for (const handle of handles) {
      expect(handle.classList.contains('text-muted-foreground/0')).toBe(false)
      expect(handle.classList.contains('text-muted-foreground/60')).toBe(true)
    }
    expect(canvas.getAllByTestId('preset-drag-placeholder').length).toBe(4)
  },
}

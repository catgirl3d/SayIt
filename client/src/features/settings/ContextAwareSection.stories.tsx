import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import ContextAwareSection from './ContextAwareSection'
import type { AiProfile } from './aiProviderCatalog'
import { CONTEXT_SELECTION_EDIT_PROMPT } from '@/services/contextAware'
import { setAiEnabled } from '@/stores/aiEnabled'
import type { UsageSummary } from '@/types/usage'

const profiles = [
  {
    id: 'ai-storybook-openai',
    provider: 'openai',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-storybook-openai',
    model: 'gpt-5-mini',
  },
  {
    id: 'ai-storybook-incomplete',
    provider: 'openai',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    model: 'gpt-5',
  },
] satisfies AiProfile[]

const baseSettings = {
  contextAwareWritingEnabled: true,
  'cloudAi.profiles': profiles,
  'cloudAi.activeProfileId': profiles[0].id,
  'cloudAi.profilesMigrated': true,
}

const emptyUsageSummary: UsageSummary = {
  takes: 0,
  totalChars: 0,
  totalDurationSec: 0,
  datedTakes: 0,
  datedChars: 0,
  maxDurationSec: 0,
  activeDays: 0,
  hourBuckets: Array.from({ length: 24 }, () => 0),
  apps: [],
  workModes: [],
  promptPresets: [],
  firstUsedAt: 0,
  lastUsedAt: 0,
}

/**
 * Saving the toggle or the prompt refreshes the recorder, which reads usage stats, and the AI
 * cleanup store pushes its state to the tray. Both are native calls the story must answer.
 */
const nativeCommands = {
  usage_summary: () => emptyUsageSummary,
  set_tray_ai_enabled: () => null,
}

/**
 * The AI cleanup switch lives in a global store that the app initializes at startup; Storybook
 * does not, so each story sets it explicitly.
 */
const aiCleanup = (enabled: boolean) => async () => {
  await setAiEnabled(enabled)
}

/** The prompt editor is a Modal portaled into document.body, outside the story canvas. */
function bodyOf(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body)
}

async function openPromptDialog(canvasElement: HTMLElement) {
  await userEvent.click(await within(canvasElement).findByRole('button', { name: /view and edit prompt/i }))
  return within(await bodyOf(canvasElement).findByRole('dialog', { name: /selection-edit prompt/i }))
}

const meta = {
  title: 'settings/ContextAwareSection',
  component: ContextAwareSection,
  parameters: { tauri: { commands: nativeCommands } },
  // beforeEach hooks compose from the project down to the story, so a story can override this.
  beforeEach: aiCleanup(true),
} satisfies Meta<typeof ContextAwareSection>

export default meta
type Story = StoryObj<typeof meta>

export const Enabled: Story = {
  parameters: { tauri: { settings: baseSettings } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = await canvas.findByRole('switch', { name: /context and selection awareness/i })
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
    await expect(canvas.getByText(/ai refers to text near the cursor/i)).toBeVisible()
  },
}

export const InfoTooltip: Story = {
  parameters: { tauri: { settings: baseSettings } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const body = bodyOf(canvasElement)
    // The how-it-works text lives only in the tooltip, not in the card itself.
    await expect(canvas.queryByText(/through Windows UI Automation/i)).toBeNull()
    await userEvent.hover(canvas.getByLabelText(/learn what context awareness does/i))
    await expect(await body.findByText(/through Windows UI Automation/i)).toBeVisible()
  },
}

export const Disabled: Story = {
  parameters: { tauri: { settings: { ...baseSettings, contextAwareWritingEnabled: false } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = await canvas.findByRole('switch', { name: /context and selection awareness/i })
    await expect(toggle).toHaveAttribute('aria-checked', 'false')
  },
}

export const ToggleSavesPreference: Story = {
  parameters: { tauri: { settings: { ...baseSettings, contextAwareWritingEnabled: false } } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const toggle = await canvas.findByRole('switch', { name: /context and selection awareness/i })
    await userEvent.click(toggle)
    await waitFor(() => expect(toggle).toHaveAttribute('aria-checked', 'true'))
  },
}

export const AiCleanupOff: Story = {
  parameters: { tauri: { settings: baseSettings } },
  beforeEach: aiCleanup(false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    // The saved preference stays on, but the hint explains why nothing is read.
    await expect(await canvas.findByText(/works only while ai processing is on/i)).toBeVisible()
    await expect(canvas.queryByText(/ai refers to text near the cursor/i)).toBeNull()
    await expect(canvas.getByRole('switch', { name: /context and selection awareness/i })).toHaveAttribute('aria-checked', 'true')
    await expect(canvas.getByRole('switch', { name: /context and selection awareness/i })).toBeDisabled()
  },
}

export const SelectionModelChosen: Story = {
  parameters: {
    tauri: { settings: { ...baseSettings, contextSelectionAiProfileId: profiles[0].id } },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByText(/gpt-5-mini/i)).toBeVisible()
  },
}

export const SelectionModelRemoved: Story = {
  parameters: {
    tauri: { settings: { ...baseSettings, contextSelectionAiProfileId: 'ai-storybook-removed' } },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/this ai service was removed/i)).toBeVisible()
  },
}

export const SelectionModelIncomplete: Story = {
  parameters: {
    tauri: { settings: { ...baseSettings, contextSelectionAiProfileId: profiles[1].id } },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/this ai service is incomplete/i)).toBeVisible()
  },
}

export const NoAiServices: Story = {
  parameters: {
    tauri: {
      settings: { ...baseSettings, 'cloudAi.profiles': [], 'cloudAi.activeProfileId': '' },
    },
  },
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement).findByText(/add a model in ai services/i)).toBeVisible()
  },
}

export const EditPromptDialog: Story = {
  parameters: { tauri: { settings: baseSettings } },
  play: async ({ canvasElement }) => {
    const dialog = await openPromptDialog(canvasElement)
    await expect(dialog.getByRole('textbox', { name: /selection-edit prompt/i })).toHaveValue(CONTEXT_SELECTION_EDIT_PROMPT)
  },
}

export const RestoreDefaultPrompt: Story = {
  parameters: {
    tauri: { settings: { ...baseSettings, contextSelectionEditPrompt: 'Only translate the selection.' } },
  },
  play: async ({ canvasElement }) => {
    const dialog = await openPromptDialog(canvasElement)
    const field = dialog.getByRole('textbox')
    await expect(field).toHaveValue('Only translate the selection.')

    await userEvent.click(dialog.getByRole('button', { name: /restore default prompt/i }))
    await expect(field).toHaveValue(CONTEXT_SELECTION_EDIT_PROMPT)
  },
}

export const SaveCustomPrompt: Story = {
  parameters: { tauri: { settings: baseSettings } },
  play: async ({ canvasElement }) => {
    const dialog = await openPromptDialog(canvasElement)
    const field = dialog.getByRole('textbox')
    await userEvent.clear(field)
    // An empty prompt cannot be saved.
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled()

    await userEvent.type(field, 'Rewrite the selection formally.')
    await userEvent.click(dialog.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(bodyOf(canvasElement).queryByRole('dialog')).toBeNull())

    // Reopening shows the saved prompt rather than the default.
    const reopened = await openPromptDialog(canvasElement)
    await expect(reopened.getByRole('textbox')).toHaveValue('Rewrite the selection formally.')
  },
}

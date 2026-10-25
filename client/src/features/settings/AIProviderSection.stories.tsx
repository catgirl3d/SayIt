import type { Meta, StoryObj } from '@storybook/react-vite'
import { expect, userEvent, waitFor, within } from 'storybook/test'
import { setAiEnabled } from '@/stores/aiEnabled'
import AIProviderSection from './AIProviderSection'
import type { AiProfile } from './aiProviderCatalog'

const profiles = [
  {
    id: 'ai-storybook-openai',
    provider: 'openai',
    apiUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-storybook-openai',
    model: 'gpt-5-mini',
    reasoningEffort: 'high',
    serviceTier: 'priority',
    check: {
      ok: true,
      at: Date.now() - 15 * 60 * 1000,
      latencyMs: 180,
    },
  },
  {
    id: 'ai-storybook-ollama',
    provider: 'ollama',
    apiUrl: 'http://127.0.0.1:11434',
    apiKey: '',
    model: 'qwen2.5:7b',
    check: {
      ok: false,
      at: Date.now() - 45 * 60 * 1000,
      reason: 'The local endpoint refused the connection',
    },
  },
  {
    id: 'ai-storybook-compatible',
    provider: 'openai_compat',
    apiUrl: 'https://gateway.example.test/v1',
    apiKey: 'sk-storybook-compatible',
    model: 'deepseek-chat',
  },
] satisfies AiProfile[]

const openRouterProfile = {
  id: 'ai-storybook-openrouter',
  provider: 'openrouter',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-or-v1-storybook',
  model: 'google/gemma-4-26b-a4b-it:free',
} satisfies AiProfile

const settingsFor = (nextProfiles: AiProfile[], activeId: string, workMode: string, serverAiSource: string) => ({
  'cloudAi.profiles': nextProfiles,
  'cloudAi.activeProfileId': activeId,
  'cloudAi.profilesMigrated': true,
  workMode,
  'server.aiSource': serverAiSource,
})

const remoteCatalog = {
  ok: true,
  message: '',
  models: [
    { id: 'gpt-5-mini', name: 'GPT-5 mini', input_price_per_million: 0.25, output_price_per_million: 2 },
    { id: 'gpt-5-nano', name: 'GPT-5 nano', input_price_per_million: 0.05, output_price_per_million: 0.4 },
    { id: 'gpt-oss-20b', name: 'gpt-oss 20B', input_price_per_million: 0, output_price_per_million: 0 },
    { id: 'custom-router', name: 'Custom router' },
  ],
}

const emptySettings = settingsFor([], '', 'cloud_api', 'managed')

const aiCleanup = (enabled: boolean) => async () => {
  await setAiEnabled(enabled)
}

/** The editor is a Modal portaled into document.body, outside the story canvas. */
function bodyOf(canvasElement: HTMLElement) {
  return within(canvasElement.ownerDocument.body)
}

async function openNewDialog(canvasElement: HTMLElement) {
  await userEvent.click(await within(canvasElement).findByRole('button', { name: /^new$/i }))
  return within(await bodyOf(canvasElement).findByRole('dialog', { name: /new ai service/i }))
}

const meta = {
  title: 'settings/AIProviderSection',
  component: AIProviderSection,
  parameters: { tauri: { commands: { set_tray_ai_enabled: () => null } } },
  beforeEach: aiCleanup(true),
} satisfies Meta<typeof AIProviderSection>

export default meta
type Story = StoryObj<typeof meta>

export const ConfiguredProfiles: Story = {
  parameters: {
    tauri: {
      settings: settingsFor(profiles, profiles[0].id, 'cloud_api', 'managed'),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    const group = within(await canvas.findByRole('radiogroup', { name: 'AI services' }))
    await expect(group.getAllByRole('radio')).toHaveLength(profiles.length)

    // The dashed tile is the last grid cell but not a radio option, so it stays outside the group.
    await expect(canvas.getByRole('button', { name: /^new$/i })).toBeVisible()
    await expect(group.queryByRole('button', { name: /^new$/i })).toBeNull()
    await expect(canvas.getByRole('button', { name: 'Test all' })).toBeEnabled()
  },
}

export const ServerModeCustomAI: Story = {
  parameters: {
    tauri: {
      settings: settingsFor(profiles, profiles[2].id, 'server', 'custom'),
    },
  },
}

export const ServerModeManagedAI: Story = {
  parameters: {
    tauri: {
      settings: settingsFor(profiles, profiles[0].id, 'server', 'managed'),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(await canvas.findByText(/server handles ai processing for ordinary dictation/i)).toBeVisible()
  },
}

export const AiCleanupOff: Story = {
  parameters: {
    tauri: {
      settings: settingsFor(profiles, profiles[0].id, 'cloud_api', 'managed'),
    },
  },
  beforeEach: aiCleanup(false),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    await expect(await canvas.findByText(/ai processing is off/i)).toBeVisible()
    // The hint must not make the editable and testable cards look unavailable.
    await expect(canvas.getByRole('button', { name: /^new$/i })).toBeEnabled()
    const cards = await canvas.findAllByRole('radio')
    await expect(cards[0]).toBeEnabled()
  },
}

export const EmptyState: Story = {
  parameters: {
    tauri: {
      settings: settingsFor([], '', 'cloud_api', 'managed'),
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)

    // With no cards the tile carries the "no services" note and is the only action.
    const tile = await canvas.findByRole('button', { name: /^new$/i })
    await expect(tile).toHaveAccessibleDescription('No AI services configured yet.')
    await expect(canvas.getByText('No AI services configured yet.')).toBeVisible()
    await expect(canvas.queryByRole('radiogroup')).toBeNull()
    await expect(canvas.getByRole('button', { name: 'Test all' })).toBeDisabled()
  },
}

export const NewServiceDialog: Story = {
  parameters: { tauri: { settings: emptySettings } },
  play: async ({ canvasElement }) => {
    const dialog = await openNewDialog(canvasElement)

    // No model is preselected: a preset would be saved next to whatever the user picks.
    await expect(dialog.getByRole('textbox', { name: 'Model' })).toHaveValue('')
    await expect(dialog.queryAllByRole('button', { name: /^remove /i })).toHaveLength(0)
    await expect(dialog.getByText(/each model becomes its own card/i)).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save' })).toBeVisible()
  },
}

export const NewServiceProviderGroups: Story = {
  parameters: { tauri: { settings: emptySettings } },
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    const dialog = await openNewDialog(canvasElement)

    await userEvent.click(dialog.getByRole('button', { name: 'OpenAI-compatible' }))
    for (const heading of ['Global', 'China', 'Local and custom']) {
      await expect(await body.findByText(heading)).toBeVisible()
    }

    await userEvent.click(body.getByRole('button', { name: 'Groq' }))
    await expect(dialog.getByRole('button', { name: 'Groq' })).toBeVisible()
  },
}

export const NewServiceSeveralModels: Story = {
  parameters: { tauri: { settings: emptySettings } },
  play: async ({ canvasElement }) => {
    const dialog = await openNewDialog(canvasElement)

    const field = dialog.getByRole('textbox', { name: 'Model' })
    await userEvent.type(field, 'model-a{Enter}model-b{Enter}')

    await expect(dialog.getByRole('button', { name: 'Remove model-a' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Remove model-b' })).toBeVisible()
    // Each chip becomes its own card, and the Save button says how many.
    await expect(dialog.getByRole('button', { name: 'Save (2)' })).toBeVisible()
  },
}

export const NewServiceLoadedCatalog: Story = {
  parameters: {
    tauri: {
      settings: emptySettings,
      commands: { list_remote_models: () => remoteCatalog },
    },
  },
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    const dialog = await openNewDialog(canvasElement)

    await userEvent.type(dialog.getByRole('textbox', { name: 'Model' }), 'typed-model{Enter}')
    await userEvent.click(dialog.getByRole('button', { name: 'Load models' }))

    // The same field turns into a combobox over the loaded catalog; the typed chip stays.
    const field = await dialog.findByRole('combobox', { name: 'Model' })
    await expect(dialog.getByRole('button', { name: 'Remove typed-model' })).toBeVisible()

    await userEvent.click(field)
    const listbox = within(await body.findByRole('listbox'))
    await expect(listbox.getAllByRole('option')).toHaveLength(remoteCatalog.models.length)
    await expect(listbox.getByRole('option', { name: /gpt-oss 20b/i })).toHaveTextContent('Free')

    await userEvent.click(listbox.getByRole('option', { name: /gpt-5 mini/i }))
    await userEvent.click(listbox.getByRole('option', { name: /gpt-5 nano/i }))
    await expect(dialog.getByRole('button', { name: 'Remove gpt-5-mini' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Remove gpt-5-nano' })).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Save (3)' })).toBeVisible()

    // Un-choosing a row removes its chip again.
    await userEvent.click(listbox.getByRole('option', { name: /gpt-5 nano/i }))
    await waitFor(() => expect(dialog.queryByRole('button', { name: 'Remove gpt-5-nano' })).toBeNull())
  },
}

export const EditServiceDialog: Story = {
  parameters: {
    tauri: {
      settings: settingsFor(profiles, profiles[0].id, 'cloud_api', 'managed'),
      commands: { list_remote_models: () => remoteCatalog },
    },
  },
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    // A card's actions appear on hover or focus, and synthetic pointer events do not trigger :hover, so focus reveals the button.
    const editButton = await within(canvasElement).findByRole('button', { name: `Edit ${profiles[0].model}` })
    editButton.focus()
    await userEvent.click(editButton)
    const dialog = within(await body.findByRole('dialog', { name: /edit ai service/i }))

    // An existing card holds exactly one model, so the field is plain text: no chips, no extra hint.
    await expect(dialog.getByRole('textbox', { name: 'Model' })).toHaveValue(profiles[0].model)
    await expect(dialog.queryAllByRole('button', { name: /^remove /i })).toHaveLength(0)

    await userEvent.click(dialog.getByRole('button', { name: 'Load models' }))
    const field = await dialog.findByRole('combobox', { name: 'Model' })
    await expect(field).toHaveValue(profiles[0].model)
    await userEvent.click(field)
    await userEvent.click(within(await body.findByRole('listbox')).getByRole('option', { name: /gpt-5 nano/i }))

    // Picking replaces the text and closes the list.
    await expect(field).toHaveValue('gpt-5-nano')
    await waitFor(() => expect(body.queryByRole('listbox')).toBeNull())
  },
}

export const NewOpenRouterServiceRecommended: Story = {
  parameters: {
    tauri: { settings: settingsFor([openRouterProfile], openRouterProfile.id, 'cloud_api', 'managed') },
  },
  play: async ({ canvasElement }) => {
    const body = bodyOf(canvasElement)
    // "New" starts from the active card's provider, so OpenRouter's curated models are offered right away.
    const dialog = await openNewDialog(canvasElement)

    // The crown alone labels the picks; hovering it shows the word.
    await expect(dialog.queryByText('Recommended')).toBeNull()
    await userEvent.hover(dialog.getByLabelText('Recommended'))
    await expect(await body.findByText('Recommended')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'deepseek/deepseek-v4.1-flash-1017' })).toBeVisible()
    await userEvent.click(dialog.getByRole('button', { name: 'anthropic/claude-haiku-5.5' }))

    await expect(dialog.getByRole('button', { name: 'Remove anthropic/claude-haiku-5.5' })).toBeVisible()
    await expect(dialog.queryByRole('button', { name: 'anthropic/claude-haiku-5.5' })).toBeNull()
  },
}

// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import AIProviderSection from '../AIProviderSection'
import { blankProfile, type AiProfile } from '../aiProviderCatalog'

// The editor's model field: a new service starts without a model (no seeded preset that
// would be saved next to the user's own pick), the chips and the typed text are the only
// source of truth for what is saved and tested, and an existing card keeps exactly one model.

const storeMocks = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }))
const profileStoreMocks = vi.hoisted(() => ({ loadAiProfiles: vi.fn(), saveAiProfiles: vi.fn() }))
const coreMocks = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@/services/store', () => ({
  getSetting: storeMocks.getSetting,
  setSetting: storeMocks.setSetting,
}))
vi.mock('../aiProfileStore', () => ({
  loadAiProfiles: profileStoreMocks.loadAiProfiles,
  saveAiProfiles: profileStoreMocks.saveAiProfiles,
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: coreMocks.invoke }))

const catalog = {
  ok: true,
  message: '',
  models: [
    { id: 'alpha-1', name: 'Alpha One', input_price_per_million: 1, output_price_per_million: 2 },
    { id: 'beta-2', name: 'Beta Two', input_price_per_million: 0.5, output_price_per_million: 1 },
    { id: 'gamma-3', name: 'Gamma Three' },
  ],
}

const saved: AiProfile = { ...blankProfile('deepseek'), id: 'p-saved', apiKey: 'sk-test' }

beforeEach(() => {
  storeMocks.getSetting.mockReset()
  storeMocks.setSetting.mockReset()
  profileStoreMocks.loadAiProfiles.mockReset()
  profileStoreMocks.saveAiProfiles.mockReset()
  coreMocks.invoke.mockReset()
  storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) =>
    key === 'workMode' ? 'local' : fallback)
  profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [], activeId: '' })
  profileStoreMocks.saveAiProfiles.mockResolvedValue(undefined)
  coreMocks.invoke.mockImplementation(async (command: string) => {
    if (command === 'list_remote_models') return catalog
    return { ok: true, message: '', elapsed_ms: 120, detail: '' }
  })
})

async function openNewDialog(): Promise<HTMLInputElement> {
  render(<AIProviderSection />)
  fireEvent.click(await screen.findByRole('button', { name: t('common.new') }))
  return await screen.findByLabelText(t('ai.model')) as HTMLInputElement
}

async function openEditDialog(profile: AiProfile): Promise<HTMLInputElement> {
  profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [profile], activeId: profile.id })
  render(<AIProviderSection />)
  fireEvent.click(await screen.findByLabelText(t('ai.editAria', { title: profile.model })))
  return await screen.findByLabelText(t('ai.model')) as HTMLInputElement
}

async function fillKey(key = 'sk-test') {
  fireEvent.change(await screen.findByLabelText('API Key'), { target: { value: key } })
}

function typeModel(input: HTMLInputElement, text: string, commit = false) {
  fireEvent.change(input, { target: { value: text } })
  if (commit) fireEvent.keyDown(input, { key: 'Enter' })
}

const chip = (id: string) => screen.queryByRole('button', { name: t('ai.removeModel', { model: id }) })

async function savedWrite(): Promise<{ profiles: AiProfile[]; activeId: string }> {
  await waitFor(() => expect(profileStoreMocks.saveAiProfiles).toHaveBeenCalledTimes(1))
  return profileStoreMocks.saveAiProfiles.mock.calls[0][0] as { profiles: AiProfile[]; activeId: string }
}

describe('AIProviderSection model field: a new service', () => {
  it('starts without a model: no chip, an empty field, and the multi-card hint', async () => {
    const input = await openNewDialog()

    expect(input.value).toBe('')
    expect(input.placeholder).toBe(t('ai.modelPlaceholder'))
    expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0)
    expect(screen.getByText(t('ai.multiModelHint'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('common.save') })).toBeTruthy()
  })

  it('saves exactly the typed model as the active card', async () => {
    const input = await openNewDialog()
    typeModel(input, 'my-model')
    await fillKey()
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))

    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual(['my-model'])
    expect(write.activeId).toBe(write.profiles[0].id)
  })

  it('tests the typed model, not a preset', async () => {
    const input = await openNewDialog()
    typeModel(input, 'my-model')
    await fillKey()
    fireEvent.click(screen.getByRole('button', { name: t('ai.testConnection') }))

    await waitFor(() => expect(coreMocks.invoke).toHaveBeenCalledWith('test_ai_connection', expect.anything()))
    const call = coreMocks.invoke.mock.calls.find(([command]) => command === 'test_ai_connection')
    expect((call?.[1] as { config: { model: string } }).config.model).toBe('my-model')
  })

  it('asks for a model before testing when none was entered', async () => {
    await openNewDialog()
    await fillKey()
    fireEvent.click(screen.getByRole('button', { name: t('ai.testConnection') }))

    expect(await screen.findByText(t('ai.err.testNoModel'))).toBeTruthy()
    expect(coreMocks.invoke).not.toHaveBeenCalledWith('test_ai_connection', expect.anything())
  })

  it('creates one card per chip, counts them on the Save button, and activates the first', async () => {
    const input = await openNewDialog()
    typeModel(input, 'model-a', true)
    typeModel(input, 'model-b', true)
    await fillKey()

    expect(chip('model-a')).toBeTruthy()
    expect(chip('model-b')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('ai.saveCount', { count: 2 }) }))

    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual(['model-a', 'model-b'])
    expect(write.activeId).toBe(write.profiles[0].id)
  })

  it('counts a name that was typed but not committed yet', async () => {
    const input = await openNewDialog()
    typeModel(input, 'model-a', true)
    typeModel(input, 'model-b')
    await fillKey()

    fireEvent.click(screen.getByRole('button', { name: t('ai.saveCount', { count: 2 }) }))

    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual(['model-a', 'model-b'])
  })

  it('does not bring a removed chip back when the model list is loaded', async () => {
    const input = await openNewDialog()
    await fillKey()
    typeModel(input, 'model-a', true)
    fireEvent.click(chip('model-a') as HTMLElement)
    expect(chip('model-a')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('ai.fetchModels') }))
    expect(await screen.findByRole('combobox', { name: t('ai.model') })).toBeTruthy()

    expect(chip('model-a')).toBeNull()
    expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0)
  })

  it('keeps the chips and picks several models from the loaded list', async () => {
    const input = await openNewDialog()
    await fillKey()
    typeModel(input, 'model-a', true)

    fireEvent.click(screen.getByRole('button', { name: t('ai.fetchModels') }))
    const field = await screen.findByRole('combobox', { name: t('ai.model') })
    expect(chip('model-a')).toBeTruthy()

    fireEvent.click(field)
    const listbox = await screen.findByRole('listbox')
    fireEvent.click(within(listbox).getByRole('option', { name: /Alpha One/ }))
    fireEvent.click(within(listbox).getByRole('option', { name: /Beta Two/ }))
    expect(chip('alpha-1')).toBeTruthy()
    expect(chip('beta-2')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('ai.saveCount', { count: 3 }) }))
    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual(['model-a', 'alpha-1', 'beta-2'])
  })
})

describe('AIProviderSection model field: an existing card', () => {
  it('shows its single model as the text of a plain field, with no chip and no extra hint', async () => {
    const input = await openEditDialog(saved)

    expect(input.value).toBe(saved.model)
    expect(chip(saved.model)).toBeNull()
    expect(screen.queryAllByRole('button', { name: /^Remove / })).toHaveLength(0)
    expect(screen.queryByText(t('ai.multiModelHint'))).toBeNull()
  })

  it('saves the edited text as the card model instead of adding a second card', async () => {
    const input = await openEditDialog(saved)
    fireEvent.change(input, { target: { value: 'deepseek-other' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))

    const write = await savedWrite()
    expect(write.profiles).toHaveLength(1)
    expect(write.profiles[0]).toMatchObject({ id: saved.id, model: 'deepseek-other' })
  })

  it('tests the edited text', async () => {
    const input = await openEditDialog(saved)
    fireEvent.change(input, { target: { value: 'deepseek-other' } })
    fireEvent.click(screen.getByRole('button', { name: t('ai.testConnection') }))

    await waitFor(() => expect(coreMocks.invoke).toHaveBeenCalledWith('test_ai_connection', expect.anything()))
    const call = coreMocks.invoke.mock.calls.find(([command]) => command === 'test_ai_connection')
    expect((call?.[1] as { config: { model: string } }).config.model).toBe('deepseek-other')
  })

  it('Enter in the field does not add a card or a chip', async () => {
    const input = await openEditDialog(saved)
    fireEvent.change(input, { target: { value: 'deepseek-other' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(chip('deepseek-other')).toBeNull()
    expect(input.value).toBe('deepseek-other')
  })

  it('keeps an emptied field as a card without a model', async () => {
    const input = await openEditDialog(saved)
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))

    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual([''])
  })

  it('picks the replacement from the loaded list: the text becomes the picked id and the list closes', async () => {
    const input = await openEditDialog(saved)
    fireEvent.click(screen.getByRole('button', { name: t('ai.fetchModels') }))
    const field = await screen.findByRole('combobox', { name: t('ai.model') })

    fireEvent.click(field)
    // The field holds the current model, but the list opens unfiltered.
    const listbox = await screen.findByRole('listbox')
    expect(within(listbox).getAllByRole('option')).toHaveLength(catalog.models.length)
    fireEvent.click(within(listbox).getByRole('option', { name: /Gamma Three/ }))

    expect(input.value).toBe('gamma-3')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual(['gamma-3'])
  })

  it('keeps the model text when the list is loaded', async () => {
    const input = await openEditDialog(saved)
    fireEvent.click(screen.getByRole('button', { name: t('ai.fetchModels') }))
    await screen.findByRole('combobox', { name: t('ai.model') })

    expect(input.value).toBe(saved.model)
  })
})

describe('AIProviderSection model field: recommended models', () => {
  const openrouter: AiProfile = { ...blankProfile('openrouter'), id: 'p-or', apiKey: 'sk-or-test' }
  const recommended = ['deepseek/deepseek-v4.1-flash-1017', 'anthropic/claude-haiku-5.5']
  const pick = (id: string) => screen.getByRole('button', { name: id })

  async function openNewOpenRouterDialog(): Promise<HTMLInputElement> {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [openrouter], activeId: openrouter.id })
    render(<AIProviderSection />)
    fireEvent.click(await screen.findByRole('button', { name: t('common.new') }))
    return await screen.findByLabelText(t('ai.model')) as HTMLInputElement
  }

  it('offers the OpenRouter recommendations as one-click picks', async () => {
    await openNewOpenRouterDialog()

    expect(screen.getByText(t('ai.modelRecommended'))).toBeTruthy()
    for (const id of recommended) expect(pick(id)).toBeTruthy()
  })

  it('does not show the row for a provider without recommendations', async () => {
    await openNewDialog()

    expect(screen.queryByText(t('ai.modelRecommended'))).toBeNull()
  })

  it('a pick in a new service becomes a chip and leaves the row', async () => {
    await openNewOpenRouterDialog()
    fireEvent.click(pick('anthropic/claude-haiku-5.5'))

    expect(chip('anthropic/claude-haiku-5.5')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'anthropic/claude-haiku-5.5' })).toBeNull()
    expect(pick('deepseek/deepseek-v4.1-flash-1017')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual([openrouter.model, 'anthropic/claude-haiku-5.5'])
  })

  it('several picks make several cards, and the row is gone when all are chosen', async () => {
    await openNewOpenRouterDialog()
    for (const id of recommended) fireEvent.click(pick(id))

    expect(screen.queryByText(t('ai.modelRecommended'))).toBeNull()
    expect(screen.getByRole('button', { name: t('ai.saveCount', { count: 2 }) })).toBeTruthy()
  })

  it('a pick in an existing card replaces the model text', async () => {
    const input = await openEditDialog(openrouter)
    expect(input.value).toBe(openrouter.model)

    fireEvent.click(pick('deepseek/deepseek-v4.1-flash-1017'))
    expect(input.value).toBe('deepseek/deepseek-v4.1-flash-1017')
    expect(screen.queryByRole('button', { name: 'deepseek/deepseek-v4.1-flash-1017' })).toBeNull()
    expect(pick('anthropic/claude-haiku-5.5')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))
    const write = await savedWrite()
    expect(write.profiles.map((p) => p.model)).toEqual(['deepseek/deepseek-v4.1-flash-1017'])
  })

  it('marks recommended rows with the crown in the loaded list', async () => {
    coreMocks.invoke.mockImplementation(async (command: string) =>
      command === 'list_remote_models'
        ? { ok: true, message: '', models: [{ id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5' }, { id: 'other/model' }] }
        : { ok: true, message: '', elapsed_ms: 1, detail: '' })
    await openNewOpenRouterDialog()
    fireEvent.click(screen.getByRole('button', { name: t('ai.fetchModels') }))
    fireEvent.click(await screen.findByRole('combobox', { name: t('ai.model') }))

    const listbox = await screen.findByRole('listbox')
    const haiku = within(listbox).getByRole('option', { name: /Claude Haiku 5\.5/ })
    expect(within(haiku).getByRole('img', { name: t('local.recommended') })).toBeTruthy()
    expect(within(listbox).getAllByRole('img', { name: t('local.recommended') })).toHaveLength(1)
  })
})

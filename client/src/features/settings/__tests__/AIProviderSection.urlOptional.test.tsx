// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import AIProviderSection from '../AIProviderSection'
import { blankProfile, type AiProfile } from '../aiProviderCatalog'

// OpenRouter is the first provider whose URL field may be left blank: the editor
// promises the official endpoint instead. These tests pin the whole promise down
// at the persistence and IPC boundaries: a cleared URL must not block saving or
// testing, and it must not loosen the rules for providers that require a URL.

const storeMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

const profileStoreMocks = vi.hoisted(() => ({
  loadAiProfiles: vi.fn(),
  saveAiProfiles: vi.fn(),
}))

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

const openrouter: AiProfile = {
  ...blankProfile('openrouter'),
  id: 'p-openrouter',
  apiKey: 'sk-or-v1-test',
}

const deepseek: AiProfile = {
  ...blankProfile('deepseek'),
  id: 'p-deepseek',
  apiKey: 'sk-test',
}

async function openEditor(profile: AiProfile, urlLabel: string): Promise<HTMLInputElement> {
  fireEvent.click(await screen.findByLabelText(t('ai.editAria', { title: profile.model })))
  return await screen.findByLabelText(urlLabel) as HTMLInputElement
}

beforeEach(() => {
  storeMocks.getSetting.mockReset()
  storeMocks.setSetting.mockReset()
  profileStoreMocks.loadAiProfiles.mockReset()
  profileStoreMocks.saveAiProfiles.mockReset()
  coreMocks.invoke.mockReset()
  storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) =>
    key === 'workMode' ? 'local' : fallback)
  profileStoreMocks.saveAiProfiles.mockResolvedValue(undefined)
})

describe('AIProviderSection optional API URL', () => {
  it('saves the official endpoint when an optional URL is cleared', async () => {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [openrouter], activeId: openrouter.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(openrouter, t('ai.apiUrlOptional'))
    expect(urlInput.value).toBe('https://openrouter.ai/api/v1')
    expect(urlInput.getAttribute('aria-describedby')).toBe('ai-api-url-hint')
    expect(screen.getByText(t('ai.apiUrlOptionalHint'))).toBeTruthy()

    fireEvent.change(urlInput, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))

    await waitFor(() => expect(profileStoreMocks.saveAiProfiles).toHaveBeenCalledTimes(1))
    const saved = profileStoreMocks.saveAiProfiles.mock.calls[0][0] as { profiles: AiProfile[] }
    expect(saved.profiles[0].apiUrl).toBe('https://openrouter.ai/api/v1')
  })

  it('still refuses to save a cleared URL for a provider that requires one', async () => {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [deepseek], activeId: deepseek.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(deepseek, t('ai.apiUrl'))
    expect(screen.queryByText(t('ai.apiUrlOptionalHint'))).toBeNull()

    fireEvent.change(urlInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))

    expect(await screen.findByText(t('ai.err.apiUrlEmpty'))).toBeTruthy()
    expect(profileStoreMocks.saveAiProfiles).not.toHaveBeenCalled()
  })

  it('tests the connection against the official endpoint when the URL is blank', async () => {
    coreMocks.invoke.mockResolvedValue({ ok: true, elapsed_ms: 120, detail: '' })
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [openrouter], activeId: openrouter.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(openrouter, t('ai.apiUrlOptional'))
    fireEvent.change(urlInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: t('ai.testConnection') }))

    await waitFor(() => expect(coreMocks.invoke).toHaveBeenCalledWith('test_ai_connection', {
      config: {
        provider: 'openrouter',
        api_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-v1-test',
        model: 'deepseek/deepseek-v4.1-flash',
      },
    }))
  })

  it('loads the model list from the official endpoint when the URL is blank', async () => {
    coreMocks.invoke.mockResolvedValue({
      ok: true,
      models: [{
        id: 'deepseek/deepseek-v4.1-flash',
        name: 'DeepSeek: DeepSeek V4.1 Flash',
        input_price_per_million: 0.15,
        output_price_per_million: 0.6,
      }],
      message: '',
    })
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [openrouter], activeId: openrouter.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(openrouter, t('ai.apiUrlOptional'))
    fireEvent.change(urlInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: t('ai.fetchModels') }))

    await waitFor(() => expect(coreMocks.invoke).toHaveBeenCalledWith('list_remote_models', {
      config: {
        provider: 'openrouter',
        api_url: 'https://openrouter.ai/api/v1',
        api_key: 'sk-or-v1-test',
        model: '',
      },
    }))

    // A non-empty catalog swaps the manual model input for the searchable picker:
    // the text input is gone, and the picker's search becomes available on open.
    const picker = await screen.findByRole('button', { name: t('ai.model') })
    expect(screen.queryByRole('textbox', { name: t('ai.model') })).toBeNull()
    fireEvent.click(picker)
    expect(await screen.findByLabelText(t('ai.modelSearch'))).toBeTruthy()
  })

  it('keeps a trimmed custom URL when saving an optional provider', async () => {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [openrouter], activeId: openrouter.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(openrouter, t('ai.apiUrlOptional'))
    fireEvent.change(urlInput, { target: { value: ' https://proxy.example/v1 ' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))

    await waitFor(() => expect(profileStoreMocks.saveAiProfiles).toHaveBeenCalledTimes(1))
    const saved = profileStoreMocks.saveAiProfiles.mock.calls[0][0] as { profiles: AiProfile[] }
    expect(saved.profiles[0].apiUrl).toBe('https://proxy.example/v1')
  })

  it('tests the connection against a custom URL the user typed', async () => {
    coreMocks.invoke.mockResolvedValue({ ok: true, elapsed_ms: 120, detail: '' })
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [openrouter], activeId: openrouter.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(openrouter, t('ai.apiUrlOptional'))
    fireEvent.change(urlInput, { target: { value: 'https://proxy.example/v1' } })
    fireEvent.click(screen.getByRole('button', { name: t('ai.testConnection') }))

    await waitFor(() => expect(coreMocks.invoke).toHaveBeenCalledWith('test_ai_connection', {
      config: {
        provider: 'openrouter',
        api_url: 'https://proxy.example/v1',
        api_key: 'sk-or-v1-test',
        model: 'deepseek/deepseek-v4.1-flash',
      },
    }))
  })

  it('refuses to test a required provider with a cleared URL', async () => {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [deepseek], activeId: deepseek.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(deepseek, t('ai.apiUrl'))
    fireEvent.change(urlInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: t('ai.testConnection') }))

    expect(await screen.findByText(t('ai.err.apiUrlEmpty'))).toBeTruthy()
    expect(coreMocks.invoke).not.toHaveBeenCalled()
  })

  it('refuses to load models for a required provider with a cleared URL', async () => {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [deepseek], activeId: deepseek.id })
    render(<AIProviderSection />)

    const urlInput = await openEditor(deepseek, t('ai.apiUrl'))
    fireEvent.change(urlInput, { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: t('ai.fetchModels') }))

    expect(await screen.findByText(t('ai.err.apiUrlEmpty'))).toBeTruthy()
    expect(coreMocks.invoke).not.toHaveBeenCalled()
  })
})

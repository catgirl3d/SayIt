// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'

const storeMocks = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }))
const profileStoreMocks = vi.hoisted(() => ({ loadAiProfiles: vi.fn() }))

vi.mock('@/services/store', () => ({
  getSetting: storeMocks.getSetting,
  setSetting: storeMocks.setSetting,
}))
vi.mock('../aiProfileStore', () => ({
  loadAiProfiles: profileStoreMocks.loadAiProfiles,
}))
vi.mock('@/services/transcription/selectionAi', () => ({
  CONTEXT_SELECTION_AI_PROFILE_KEY: 'contextSelectionAiProfileId',
}))

import ContextSelectionModelSetting from '../ContextSelectionModelSetting'

const editor = {
  id: 'p-editor', provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-edit', model: 'gpt-edit',
}
const editor2 = {
  id: 'p-pro', provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-pro', model: 'gpt-pro',
}
const incomplete = {
  id: 'p-broken', provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o',
}

describe('selection-edit model setting', () => {
  beforeEach(() => {
    storeMocks.getSetting.mockReset().mockResolvedValue('')
    storeMocks.setSetting.mockReset().mockResolvedValue(undefined)
    profileStoreMocks.loadAiProfiles.mockReset().mockResolvedValue({ profiles: [editor], activeId: '' })
  })

  it('persists a newly chosen service', async () => {
    render(<ContextSelectionModelSetting />)
    const trigger = await screen.findByRole('button', { name: t('settings.contextAware.model') })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /gpt-edit/ }))

    await waitFor(() => expect(storeMocks.setSetting).toHaveBeenCalledWith('contextSelectionAiProfileId', 'p-editor'))

    // Switching back to the dictation model persists the empty value.
    fireEvent.click(screen.getByRole('button', { name: t('settings.contextAware.model') }))
    fireEvent.click(await screen.findByRole('button', { name: t('settings.contextAware.sameModel') }))
    await waitFor(() => expect(storeMocks.setSetting).toHaveBeenCalledWith('contextSelectionAiProfileId', ''))
  })

  it('warns about a removed service and keeps its placeholder option', async () => {
    storeMocks.getSetting.mockResolvedValue('deleted')
    render(<ContextSelectionModelSetting />)

    expect(await screen.findByText(t('settings.contextAware.modelMissing'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('settings.contextAware.model') }))
    expect(await screen.findByRole('button', { name: t('settings.contextAware.modelMissingOption') })).toBeTruthy()
  })

  it('warns when the saved service is incomplete and marks it as such', async () => {
    storeMocks.getSetting.mockResolvedValue('p-broken')
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [incomplete], activeId: '' })
    render(<ContextSelectionModelSetting />)

    expect(await screen.findByText(t('settings.contextAware.modelIncomplete'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: t('settings.contextAware.model') }))
    expect(await screen.findByRole('button', { name: new RegExp(t('ai.status.incomplete')) })).toBeTruthy()
  })

  it('refreshes the list when AI services change elsewhere', async () => {
    render(<ContextSelectionModelSetting />)
    await screen.findByRole('button', { name: t('settings.contextAware.model') })

    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [editor, editor2], activeId: '' })
    window.dispatchEvent(new Event('ai-profiles-changed'))
    await waitFor(() => expect(profileStoreMocks.loadAiProfiles).toHaveBeenCalledTimes(2))

    fireEvent.click(screen.getByRole('button', { name: t('settings.contextAware.model') }))
    expect(await screen.findByRole('button', { name: /gpt-pro/ })).toBeTruthy()
  })

  it('surfaces a save failure', async () => {
    storeMocks.setSetting.mockRejectedValue(new Error('disk full'))
    render(<ContextSelectionModelSetting />)
    const trigger = await screen.findByRole('button', { name: t('settings.contextAware.model') })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /gpt-edit/ }))

    expect(await screen.findByText(t('settings.contextAware.modelSaveError'))).toBeTruthy()
  })

  it('does not offer an incomplete service that is not the saved one', async () => {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [incomplete, editor], activeId: '' })
    render(<ContextSelectionModelSetting />)
    const trigger = await screen.findByRole('button', { name: t('settings.contextAware.model') })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)

    expect(screen.queryByRole('button', { name: /gpt-4o/ })).toBeNull()
    expect(screen.getByRole('button', { name: /gpt-edit/ })).toBeTruthy()
  })

  it('replays a profile change that arrived while a save was running', async () => {
    let finishSave!: () => void
    storeMocks.setSetting.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve }))
    render(<ContextSelectionModelSetting />)
    const trigger = await screen.findByRole('button', { name: t('settings.contextAware.model') })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /gpt-edit/ }))

    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [editor, editor2], activeId: '' })
    window.dispatchEvent(new Event('ai-profiles-changed'))
    finishSave()

    await waitFor(() => expect(profileStoreMocks.loadAiProfiles).toHaveBeenCalledTimes(2))
    fireEvent.click(screen.getByRole('button', { name: t('settings.contextAware.model') }))
    expect(await screen.findByRole('button', { name: /gpt-pro/ })).toBeTruthy()
  })

  it('replays a profile change that raced a load in flight before the save', async () => {
    type ProfileLoadState = { profiles: Array<typeof editor>; activeId: string }
    let resolveDeferred!: (state: ProfileLoadState) => void
    const deferred = new Promise<ProfileLoadState>((resolve) => {
      resolveDeferred = resolve
    })

    render(<ContextSelectionModelSetting />)
    const trigger = await screen.findByRole('button', { name: t('settings.contextAware.model') })
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false))

    profileStoreMocks.loadAiProfiles.mockReturnValueOnce(deferred)
    window.dispatchEvent(new Event('ai-profiles-changed'))
    await waitFor(() => expect(profileStoreMocks.loadAiProfiles).toHaveBeenCalledTimes(2))

    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [editor, editor2], activeId: '' })
    fireEvent.click(trigger)
    fireEvent.click(await screen.findByRole('button', { name: /gpt-edit/ }))
    resolveDeferred({ profiles: [editor, editor2], activeId: '' })

    await waitFor(() => expect(profileStoreMocks.loadAiProfiles).toHaveBeenCalledTimes(3))
    fireEvent.click(trigger)
    expect(await screen.findByRole('button', { name: /gpt-pro/ })).toBeTruthy()
  })
})

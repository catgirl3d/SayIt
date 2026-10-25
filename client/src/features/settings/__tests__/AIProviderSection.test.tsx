// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { setAiEnabled } from '@/stores/aiEnabled'
import AIProviderSection from '../AIProviderSection'
import { blankProfile, type AiProfile } from '../aiProviderCatalog'

const storeMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  setSettings: vi.fn(),
}))

const profileStoreMocks = vi.hoisted(() => ({
  loadAiProfiles: vi.fn(),
  saveAiProfiles: vi.fn(),
}))

vi.mock('@/services/store', () => ({
  getSetting: storeMocks.getSetting,
  setSetting: storeMocks.setSetting,
  setSettings: storeMocks.setSettings,
}))

vi.mock('../aiProfileStore', () => ({
  loadAiProfiles: profileStoreMocks.loadAiProfiles,
  saveAiProfiles: profileStoreMocks.saveAiProfiles,
}))

const profile = {
  ...blankProfile('deepseek'),
  id: 'p-test',
  model: 'deepseek-v4-flash',
  apiKey: 'sk-test',
}

const saveFailure = new Error('disk full')
const activationFailureText = t('ai.msg.activationFailed', { message: t('err.connectFailed') })
const deleteFailureText = t('ai.msg.deleteFailed', { message: t('err.connectFailed') })

describe('AIProviderSection persistence failures', () => {
  beforeEach(() => {
    storeMocks.getSetting.mockReset()
    storeMocks.setSetting.mockReset()
    profileStoreMocks.loadAiProfiles.mockReset()
    profileStoreMocks.saveAiProfiles.mockReset()
    storeMocks.getSetting.mockImplementation(async (key: string) => key === 'workMode' ? 'local' : 'managed')
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [profile], activeId: '' })
  })

  it('activates the clicked profile after a successful save', async () => {
    profileStoreMocks.saveAiProfiles.mockResolvedValue(undefined)
    render(<AIProviderSection />)

    const radio = await screen.findByRole('radio')
    expect(radio.getAttribute('aria-checked')).toBe('false')

    fireEvent.click(radio)

    await waitFor(() => expect(screen.getByRole('radio').getAttribute('aria-checked')).toBe('true'))
    expect(profileStoreMocks.saveAiProfiles).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(activationFailureText)).toBeNull()
  })

  it('shows an error notice when activating the profile fails to save', async () => {
    profileStoreMocks.saveAiProfiles.mockRejectedValue(saveFailure)
    render(<AIProviderSection />)

    fireEvent.click(await screen.findByRole('radio'))

    expect(await screen.findByText(activationFailureText)).toBeTruthy()
    expect(screen.getByText('disk full')).toBeTruthy()
    expect(screen.getByRole('radio').getAttribute('aria-checked')).toBe('false')
  })

  it('re-reads the stored profiles when a save fails so the view matches storage', async () => {
    profileStoreMocks.saveAiProfiles.mockRejectedValue(saveFailure)
    profileStoreMocks.loadAiProfiles.mockReset()
    profileStoreMocks.loadAiProfiles
      .mockResolvedValueOnce({ profiles: [profile], activeId: '' })
      .mockResolvedValueOnce({ profiles: [profile], activeId: profile.id })
    render(<AIProviderSection />)

    fireEvent.click(await screen.findByRole('radio'))

    expect(await screen.findByText(activationFailureText)).toBeTruthy()
    await waitFor(() => expect(screen.getByRole('radio').getAttribute('aria-checked')).toBe('true'))
  })

  it('shows an error notice when deleting the profile fails to save', async () => {
    profileStoreMocks.saveAiProfiles.mockRejectedValue(saveFailure)
    render(<AIProviderSection />)

    fireEvent.click(await screen.findByLabelText(t('ai.deleteAria', { title: 'deepseek-v4-flash' })))
    fireEvent.click(await screen.findByRole('button', { name: t('common.delete') }))

    expect(await screen.findByText(deleteFailureText)).toBeTruthy()
    expect(screen.getByRole('radio')).toBeTruthy()
  })

  it('reconciles to the stored list when a committed deletion loses its acknowledgement', async () => {
    profileStoreMocks.saveAiProfiles.mockRejectedValue(saveFailure)
    profileStoreMocks.loadAiProfiles.mockReset()
    profileStoreMocks.loadAiProfiles
      .mockResolvedValueOnce({ profiles: [profile], activeId: '' })
      .mockResolvedValueOnce({ profiles: [], activeId: '' })
    render(<AIProviderSection />)

    fireEvent.click(await screen.findByLabelText(t('ai.deleteAria', { title: 'deepseek-v4-flash' })))
    fireEvent.click(await screen.findByRole('button', { name: t('common.delete') }))

    // The database may commit before IPC reports an error. Show the saved list,
    // without claiming that the rejected call preserved the card.
    expect(await screen.findByText(deleteFailureText)).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
  })

  it('leaves the testing state when the test verdict cannot be saved', async () => {
    profileStoreMocks.saveAiProfiles.mockRejectedValue(saveFailure)
    render(<AIProviderSection />)

    const testAria = t('ai.testAria', { title: 'deepseek-v4-flash' })
    fireEvent.click(await screen.findByLabelText(testAria))

    expect(await screen.findByText(t('ai.err.saveFailed'))).toBeTruthy()
    // A stuck checking state keeps the whole page busy: the card must not spin forever.
    await waitFor(() => {
      const button = screen.getByLabelText(testAria) as HTMLButtonElement
      expect(button.disabled).toBe(false)
      expect(button.querySelector('svg')?.getAttribute('class') ?? '').not.toContain('animate-spin')
    })
  })
})

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

describe('AIProviderSection deletion with the real profile store', () => {
  const settings = new Map<string, unknown>()
  const first = { ...profile, id: 'p-first', model: 'first-model' }
  const third = { ...profile, id: 'p-third', model: 'third-model' }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('../aiProfileStore')>('../aiProfileStore')
    profileStoreMocks.loadAiProfiles.mockReset().mockImplementation(actual.loadAiProfiles)
    profileStoreMocks.saveAiProfiles.mockReset().mockImplementation(actual.saveAiProfiles)
    settings.clear()
    settings.set('workMode', 'local')
    settings.set('cloudAi.profilesMigrated', true)
    settings.set('cloudAi.profiles', [first, profile, third])
    settings.set('cloudAi.activeProfileId', first.id)
    storeMocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => settings.get(key) ?? fallback)
    storeMocks.setSetting.mockReset().mockImplementation(async (key: string, value: unknown) => {
      settings.set(key, structuredClone(value))
    })
    storeMocks.setSettings.mockReset().mockImplementation(async (values: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(values)) settings.set(key, structuredClone(value))
    })
  })

  async function deleteProfile() {
    fireEvent.click(await screen.findByLabelText(t('ai.deleteAria', { title: profile.model })))
    fireEvent.click(await screen.findByRole('button', { name: t('common.delete') }))
  }

  it('blocks activation during deletion and never restores the deleted profile on a later activation', async () => {
    render(<AIProviderSection />)
    await screen.findByRole('radio', { name: /third-model/ })
    const gate = deferred()
    const writing = deferred()
    const holdWrite = async () => { writing.resolve(); await gate.promise }
    const commit = storeMocks.setSettings.getMockImplementation()!
    storeMocks.setSettings.mockImplementationOnce(async (values: Record<string, unknown>) => {
      await holdWrite()
      await commit(values)
    })
    try {
      await deleteProfile()
      const radio = screen.getByRole('radio', { name: /third-model/ }) as HTMLButtonElement
      expect(radio.disabled).toBe(true)
      await writing.promise
      fireEvent.click(radio)
      expect((screen.getByRole('button', { name: t('ai.testAll') }) as HTMLButtonElement).disabled).toBe(true)
    } finally {
      await act(async () => {
        gate.resolve()
        await profileStoreMocks.loadAiProfiles()
      })
    }
    await waitFor(() => expect(screen.queryByRole('radio', { name: /deepseek-v4-flash/ })).toBeNull())
    await waitFor(() => expect((screen.getByRole('radio', { name: /third-model/ }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('radio', { name: /third-model/ }))
    await waitFor(() => expect(screen.getByRole('radio', { name: /third-model/ }).getAttribute('aria-checked')).toBe('true'))
    expect((settings.get('cloudAi.profiles') as AiProfile[]).map((item) => item.id)).toEqual([first.id, third.id])
    expect(settings.get('cloudAi.activeProfileId')).toBe(third.id)
    expect(settings.get('cloudAi.model')).toBe('third-model')
  })

  it('keeps deletion busy through error reconciliation and allows retry after reconciliation finishes', async () => {
    render(<AIProviderSection />)
    await screen.findByRole('radio', { name: /third-model/ })
    const gate = deferred()
    const rereading = deferred()
    const read = storeMocks.getSetting.getMockImplementation()!
    storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'cloudAi.profiles') {
        rereading.resolve()
        await gate.promise
      }
      return read(key, fallback)
    })
    storeMocks.setSettings.mockRejectedValueOnce(saveFailure)
    try {
      await deleteProfile()
      await rereading.promise
      expect((screen.getByRole('radio', { name: /third-model/ }) as HTMLButtonElement).disabled).toBe(true)
      expect((screen.getByLabelText(t('ai.deleteAria', { title: profile.model })) as HTMLButtonElement).disabled).toBe(true)
    } finally {
      await act(async () => {
        gate.resolve()
        await profileStoreMocks.loadAiProfiles()
      })
    }
    expect(await screen.findByText(deleteFailureText)).toBeTruthy()
    await waitFor(() => expect((screen.getByRole('radio', { name: /third-model/ }) as HTMLButtonElement).disabled).toBe(false))
    await deleteProfile()
    await waitFor(() => expect(screen.queryByRole('radio', { name: /deepseek-v4-flash/ })).toBeNull())
    expect((settings.get('cloudAi.profiles') as AiProfile[]).map((item) => item.id)).toEqual([first.id, third.id])
  })

  it('deleting the last profile clears the active selection and every runtime field', async () => {
    settings.set('cloudAi.profiles', [profile])
    settings.set('cloudAi.activeProfileId', profile.id)
    render(<AIProviderSection />)
    await deleteProfile()
    await waitFor(() => expect(screen.queryByRole('radio')).toBeNull())
    expect(settings.get('cloudAi.profiles')).toEqual([])
    for (const key of ['activeProfileId', 'provider', 'apiUrl', 'apiKey', 'model', 'reasoningEffort', 'serviceTier']) {
      expect(settings.get(`cloudAi.${key}`)).toBe('')
    }
  })
})

describe('AIProviderSection usage status', () => {
  const renderWithSettings = async (mode: string, source: string) => {
    storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'workMode') return mode
      if (key === 'server.aiSource') return source
      return fallback
    })
    render(<AIProviderSection />)
    await screen.findByRole('radio')
  }

  beforeEach(async () => {
    storeMocks.getSetting.mockReset()
    storeMocks.setSetting.mockReset()
    profileStoreMocks.loadAiProfiles.mockReset()
    profileStoreMocks.saveAiProfiles.mockReset()
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [profile], activeId: '' })
    await setAiEnabled(false)
  })

  afterEach(async () => {
    await setAiEnabled(false)
  })

  it('explains that AI processing is off without blocking edits or tests', async () => {
    await renderWithSettings('server', 'managed')

    expect(await screen.findByText(t('ai.inactiveAiOff'))).toBeTruthy()
    expect((screen.getByRole('radio') as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getByRole('radio').closest('.group')?.className).toContain('opacity-60')
    expect((screen.getByRole('button', { name: /^new$/i }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('explains server-managed processing with the selected-text exception', async () => {
    await setAiEnabled(true)
    await renderWithSettings('server', 'managed')

    expect(await screen.findByText(t('ai.inactiveServerManaged'))).toBeTruthy()
    expect(screen.queryByText(t('ai.inactiveAiOff'))).toBeNull()
  })

  it('shows no status when saved services are used for dictation', async () => {
    await setAiEnabled(true)
    await renderWithSettings('server', 'custom')

    // The profile radio can load before the server source does. Wait for the source switch,
    // otherwise the negative assertion below would pass while the source is still unknown.
    const sourceSwitch = await screen.findByRole('switch', { name: t('ai.serverSource.title') })
    expect(sourceSwitch.getAttribute('aria-checked')).toBe('true')
    expect(screen.getByRole('radio').closest('.group')?.className).not.toContain('opacity-60')
    await waitFor(() => expect(screen.queryByText(t('ai.inactiveServerManaged'))).toBeNull())
    expect(screen.queryByText(t('ai.inactiveAiOff'))).toBeNull()
  })

  it('hides the status when there are no saved services left', async () => {
    profileStoreMocks.loadAiProfiles.mockResolvedValue({ profiles: [], activeId: '' })
    storeMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'workMode') return 'cloud_api'
      if (key === 'server.aiSource') return 'managed'
      return fallback
    })
    render(<AIProviderSection />)

    expect(await screen.findByText(t('ai.empty'))).toBeTruthy()
    expect(screen.queryByText(t('ai.inactiveAiOff'))).toBeNull()
    expect(screen.queryByText(t('ai.inactiveServerManaged'))).toBeNull()
  })
})

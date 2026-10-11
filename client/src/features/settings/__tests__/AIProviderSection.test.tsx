// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import AIProviderSection from '../AIProviderSection'
import { blankProfile } from '../aiProviderCatalog'

const storeMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

const profileStoreMocks = vi.hoisted(() => ({
  loadAiProfiles: vi.fn(),
  saveAiProfiles: vi.fn(),
}))

vi.mock('@/services/store', () => ({
  getSetting: storeMocks.getSetting,
  setSetting: storeMocks.setSetting,
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

  it('reconciles to the stored list when a partial write already applied the deletion', async () => {
    profileStoreMocks.saveAiProfiles.mockRejectedValue(saveFailure)
    profileStoreMocks.loadAiProfiles.mockReset()
    profileStoreMocks.loadAiProfiles
      .mockResolvedValueOnce({ profiles: [profile], activeId: '' })
      .mockResolvedValueOnce({ profiles: [], activeId: '' })
    render(<AIProviderSection />)

    fireEvent.click(await screen.findByLabelText(t('ai.deleteAria', { title: 'deepseek-v4-flash' })))
    fireEvent.click(await screen.findByRole('button', { name: t('common.delete') }))

    // Storage can be ahead of the UI when the list key landed before the runtime mirror
    // failed: after the error the list must show what is actually stored, not the stale card.
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

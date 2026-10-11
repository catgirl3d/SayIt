// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import CloudAPISection from '../CloudAPISection'
import { emptyAsrProfile, findAsrProvider } from '../asrProviderCatalog'

const storeMocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}))

const profileStoreMocks = vi.hoisted(() => ({
  loadAsrProfiles: vi.fn(),
  saveAsrProfiles: vi.fn(),
  saveAsrProfileChecks: vi.fn(),
}))

const coreMocks = vi.hoisted(() => ({ invoke: vi.fn() }))
const testAudioMocks = vi.hoisted(() => ({ prepareTestPcm: vi.fn() }))

vi.mock('@/services/store', () => ({
  getSetting: storeMocks.getSetting,
  setSetting: storeMocks.setSetting,
}))

vi.mock('../asrProfileStore', () => ({
  loadAsrProfiles: profileStoreMocks.loadAsrProfiles,
  saveAsrProfiles: profileStoreMocks.saveAsrProfiles,
  saveAsrProfileChecks: profileStoreMocks.saveAsrProfileChecks,
}))

vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/core')>()),
  invoke: coreMocks.invoke,
}))

vi.mock('../testAudio', () => ({
  prepareTestPcm: testAudioMocks.prepareTestPcm,
}))

const profile = { ...emptyAsrProfile('mimo'), id: 'a-test', apiKey: 'test-key' }
const cardTitle = findAsrProvider('mimo')?.label ?? 'mimo'
const saveFailure = new Error('disk full')
const deleteFailureText = t('asr.msg.deleteFailed', { message: t('err.connectFailed') })
const saveFailureText = t('asr.msg.saveFailed', { message: t('err.connectFailed') })
const checkSaveFailureText = t('asr.msg.testSaveFailed', { message: t('err.connectFailed') })

describe('CloudAPISection persistence failures', () => {
  beforeEach(() => {
    storeMocks.getSetting.mockReset()
    storeMocks.setSetting.mockReset()
    profileStoreMocks.loadAsrProfiles.mockReset()
    profileStoreMocks.saveAsrProfiles.mockReset()
    profileStoreMocks.saveAsrProfileChecks.mockReset()
    coreMocks.invoke.mockReset()
    testAudioMocks.prepareTestPcm.mockReset()
    storeMocks.getSetting.mockImplementation(async (_key: string, fallback: unknown) => fallback)
    profileStoreMocks.loadAsrProfiles.mockResolvedValue({ profiles: [profile], activeId: profile.id })
  })

  it('keeps the card and reports the failure when deletion cannot be saved', async () => {
    profileStoreMocks.saveAsrProfiles.mockRejectedValue(saveFailure)
    render(<CloudAPISection speechLanguage="zh" />)

    fireEvent.click(await screen.findByLabelText(t('asr.deleteAria', { title: cardTitle })))
    fireEvent.click(await screen.findByRole('button', { name: t('common.delete') }))

    expect(await screen.findByText(deleteFailureText)).toBeTruthy()
    expect(screen.getByText('disk full')).toBeTruthy()
    // The confirmation dialog must not stay open after the failed attempt.
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('radio')).toBeTruthy()
  })

  it('reports a failed save inside the editor and keeps the draft open', async () => {
    profileStoreMocks.saveAsrProfiles.mockRejectedValue(saveFailure)
    render(<CloudAPISection speechLanguage="zh" />)

    fireEvent.click(await screen.findByLabelText(t('asr.editAria', { title: cardTitle })))
    fireEvent.change(await screen.findByLabelText('API Key'), { target: { value: 'another-key' } })
    fireEvent.click(screen.getByRole('button', { name: t('common.save') }))

    expect(await screen.findByText(saveFailureText)).toBeTruthy()
    expect(screen.getByText('disk full')).toBeTruthy()
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('reports a save failure, not a missed test, when the verdict cannot be stored', async () => {
    coreMocks.invoke.mockResolvedValue({ text: 'hello world', elapsed_ms: 5 })
    testAudioMocks.prepareTestPcm.mockResolvedValue({ pcmB64: 'AA==', pcmBytes: new Uint8Array(), audioSec: 1 })
    profileStoreMocks.saveAsrProfileChecks.mockRejectedValue(saveFailure)
    render(<CloudAPISection speechLanguage="zh" />)

    const testAria = t('asr.testAria', { title: cardTitle })
    fireEvent.click(await screen.findByLabelText(testAria))

    expect(await screen.findByText(checkSaveFailureText)).toBeTruthy()
    // The recognition did run and was billed; claiming it never ran would invite a second paid run.
    expect(screen.queryByText(t('asr.msg.testCrashed', { label: cardTitle, message: t('err.connectFailed') }))).toBeNull()
    await waitFor(() => {
      expect((screen.getByLabelText(testAria) as HTMLButtonElement).disabled).toBe(false)
    })
  })
})

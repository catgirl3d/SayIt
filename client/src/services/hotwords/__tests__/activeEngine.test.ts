import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getWorkMode: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
}))

vi.mock('@/services/transcription', () => ({ getWorkMode: mocks.getWorkMode }))
vi.mock('@/features/settings/asrProfileStore', () => ({ loadActiveAsrProfile: mocks.loadActiveAsrProfile }))

import { findAsrProvider } from '@/features/settings/asrProviderCatalog'
import { loadDictationHotwordEngine } from '../activeEngine'

describe('loadDictationHotwordEngine', () => {
  beforeEach(() => {
    mocks.getWorkMode.mockReset()
    mocks.loadActiveAsrProfile.mockReset()
  })

  it('maps server mode to the server capability entry without reading profiles', async () => {
    mocks.getWorkMode.mockReturnValue('server')

    await expect(loadDictationHotwordEngine()).resolves.toEqual({
      mode: 'server',
      capabilityKey: 'server',
      providerLabel: '',
      deepgramKeytermsEnabled: false,
    })
    expect(mocks.loadActiveAsrProfile).not.toHaveBeenCalled()
  })

  it('maps local mode to the local capability entry without reading profiles', async () => {
    mocks.getWorkMode.mockReturnValue('local')

    await expect(loadDictationHotwordEngine()).resolves.toEqual({
      mode: 'local',
      capabilityKey: 'local',
      providerLabel: '',
      deepgramKeytermsEnabled: false,
    })
    expect(mocks.loadActiveAsrProfile).not.toHaveBeenCalled()
  })

  describe('in Cloud API mode', () => {
    beforeEach(() => mocks.getWorkMode.mockReturnValue('cloud_api'))

    it('uses the active profile provider as the capability key with its catalog label', async () => {
      mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'groq_whisper' })

      await expect(loadDictationHotwordEngine()).resolves.toEqual({
        mode: 'cloud_api',
        capabilityKey: 'groq_whisper',
        providerLabel: findAsrProvider('groq_whisper')?.label,
        deepgramKeytermsEnabled: false,
      })
    })

    it('resolves every Qwen Omni variant to the shared qwen_omni capability entry', async () => {
      mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'qwen_omni_35_plus' })

      await expect(loadDictationHotwordEngine()).resolves.toMatchObject({
        mode: 'cloud_api',
        capabilityKey: 'qwen_omni',
        providerLabel: findAsrProvider('qwen_omni_35_plus')?.label,
      })
    })

    it.each(['gemini_transcribe', 'qwen_audio_stream'])('keeps %s as its own capability key, not an Omni variant', async (provider) => {
      mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider })

      await expect(loadDictationHotwordEngine()).resolves.toMatchObject({
        mode: 'cloud_api',
        capabilityKey: provider,
      })
    })

    it('falls back to the raw provider id when the catalog does not know the provider', async () => {
      mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'future_provider' })

      await expect(loadDictationHotwordEngine()).resolves.toEqual({
        mode: 'cloud_api',
        capabilityKey: 'future_provider',
        providerLabel: 'future_provider',
        deepgramKeytermsEnabled: false,
      })
    })

    it('reports the Deepgram profile opt-in only when it is explicitly enabled', async () => {
      mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'deepgram', deepgramKeytermsEnabled: true })
      await expect(loadDictationHotwordEngine()).resolves.toMatchObject({
        capabilityKey: 'deepgram',
        deepgramKeytermsEnabled: true,
      })

      mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'deepgram', deepgramKeytermsEnabled: false })
      await expect(loadDictationHotwordEngine()).resolves.toMatchObject({ deepgramKeytermsEnabled: false })

      mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'deepgram' })
      await expect(loadDictationHotwordEngine()).resolves.toMatchObject({ deepgramKeytermsEnabled: false })
    })

    it('claims no engine while no ASR service is configured', async () => {
      mocks.loadActiveAsrProfile.mockResolvedValueOnce(null)

      await expect(loadDictationHotwordEngine()).resolves.toBeNull()
    })
  })
})

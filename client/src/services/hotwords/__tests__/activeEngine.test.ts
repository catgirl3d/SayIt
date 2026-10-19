import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
}))

vi.mock('@/services/store', () => ({ getSetting: mocks.getSetting }))
vi.mock('@/features/settings/asrProfileStore', () => ({ loadActiveAsrProfile: mocks.loadActiveAsrProfile }))

import { findAsrProvider } from '@/features/settings/asrProviderCatalog'
import { loadDictationHotwordEngine } from '../activeEngine'

describe('loadDictationHotwordEngine', () => {
  beforeEach(() => {
    mocks.getSetting.mockReset()
    mocks.loadActiveAsrProfile.mockReset()
  })

  it('reads the stored work mode with a server default', async () => {
    mocks.getSetting.mockResolvedValueOnce('server')

    await expect(loadDictationHotwordEngine()).resolves.toEqual({
      mode: 'server',
      capabilityKey: 'server',
      providerLabel: '',
    })
    expect(mocks.getSetting).toHaveBeenCalledWith('workMode', 'server')
    expect(mocks.loadActiveAsrProfile).not.toHaveBeenCalled()
  })

  it('treats an unrecognized stored mode as server mode', async () => {
    mocks.getSetting.mockResolvedValueOnce('legacy-mode')

    await expect(loadDictationHotwordEngine()).resolves.toMatchObject({ mode: 'server', capabilityKey: 'server' })
  })

  it('maps local mode to the local capability entry without reading profiles', async () => {
    mocks.getSetting.mockResolvedValueOnce('local')

    await expect(loadDictationHotwordEngine()).resolves.toEqual({
      mode: 'local',
      capabilityKey: 'local',
      providerLabel: '',
    })
    expect(mocks.loadActiveAsrProfile).not.toHaveBeenCalled()
  })

  it('uses the active cloud profile provider as the capability key with its catalog label', async () => {
    mocks.getSetting.mockResolvedValueOnce('cloud_api')
    mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'groq_whisper' })

    await expect(loadDictationHotwordEngine()).resolves.toEqual({
      mode: 'cloud_api',
      capabilityKey: 'groq_whisper',
      providerLabel: findAsrProvider('groq_whisper')?.label,
    })
  })

  it('resolves every Qwen Omni variant to the shared qwen_omni capability entry', async () => {
    mocks.getSetting.mockResolvedValueOnce('cloud_api')
    mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'qwen_omni_35_plus' })

    await expect(loadDictationHotwordEngine()).resolves.toMatchObject({
      mode: 'cloud_api',
      capabilityKey: 'qwen_omni',
      providerLabel: findAsrProvider('qwen_omni_35_plus')?.label,
    })
  })

  it('falls back to the raw provider id when the catalog does not know the provider', async () => {
    mocks.getSetting.mockResolvedValueOnce('cloud_api')
    mocks.loadActiveAsrProfile.mockResolvedValueOnce({ provider: 'future_provider' })

    await expect(loadDictationHotwordEngine()).resolves.toEqual({
      mode: 'cloud_api',
      capabilityKey: 'future_provider',
      providerLabel: 'future_provider',
    })
  })

  it('claims no engine in Cloud API mode while no ASR service is configured', async () => {
    mocks.getSetting.mockResolvedValueOnce('cloud_api')
    mocks.loadActiveAsrProfile.mockResolvedValueOnce(null)

    await expect(loadDictationHotwordEngine()).resolves.toBeNull()
  })
})

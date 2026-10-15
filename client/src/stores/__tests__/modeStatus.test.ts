import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  invoke: vi.fn(),
  loadAsrProfiles: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }))
vi.mock('../../services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => state.settings.get(key) ?? fallback),
}))
vi.mock('../../features/settings/asrProfileStore', () => ({ loadAsrProfiles: state.loadAsrProfiles }))
vi.mock('../../features/settings/asrProviderCatalog', () => ({
  describeAsrMissing: vi.fn(),
  findAsrProvider: vi.fn(),
  resolveActiveAsrProfile: vi.fn(),
}))
vi.mock('@/i18n', () => ({
  subscribeLocale: vi.fn(() => () => {}),
  t: vi.fn((key: string) => key),
}))

import {
  describeAsrMissing,
  findAsrProvider,
  resolveActiveAsrProfile,
} from '../../features/settings/asrProviderCatalog'
import { getModeStatus, refreshModeStatus } from '../modeStatus'

function configureLocal(
  options: {
    modelId?: string
    language?: string
    downloaded?: boolean
    catalogError?: boolean
  } = {},
) {
  state.settings.set('workMode', 'local')
  state.settings.set('localAsr.modelId', options.modelId ?? 'model')
  state.settings.set('speechInput.language', options.language ?? 'auto')
  state.invoke.mockImplementation(async (command: string) => {
    if (command === 'list_available_models') {
      if (options.catalogError) throw new Error('catalog unavailable')
      return [{ id: options.modelId ?? 'model', name: 'Model' }]
    }
    if (command === 'list_downloaded_models') {
      return options.downloaded === false ? [] : [{ id: options.modelId ?? 'model', complete: true }]
    }
    throw new Error(`Unexpected command: ${command}`)
  })
}

describe('mode status local readiness', () => {
  beforeEach(() => {
    state.settings.clear()
    state.invoke.mockReset()
    state.loadAsrProfiles.mockReset()
    vi.mocked(describeAsrMissing).mockReset()
    vi.mocked(findAsrProvider).mockReset()
    vi.mocked(resolveActiveAsrProfile).mockReset()
  })

  it('keeps an ordinary complete model ready with auto', async () => {
    configureLocal()

    await refreshModeStatus()

    expect(getModeStatus().ready).toBe(true)
  })

  it('uses the localized display name for a known local model', async () => {
    configureLocal({ modelId: 'qwen3-asr-1.7b-gguf' })

    await refreshModeStatus()

    expect(getModeStatus().detail).toBe('localModel.qwen17Accurate.name')
  })

  it('keeps a downloaded model ready when it is absent from the catalog', async () => {
    configureLocal({ modelId: 'missing', downloaded: true })
    state.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_available_models') return []
      return [{ id: 'missing', complete: true }]
    })

    await refreshModeStatus()

    expect(getModeStatus()).toMatchObject({ ready: true, blockedReason: '' })
  })

  it('keeps a downloaded model ready when the catalog lookup errors', async () => {
    configureLocal({ catalogError: true })

    await refreshModeStatus()

    expect(getModeStatus().ready).toBe(true)
  })

  it('drops readiness and keeps the display name when the downloaded list stops working', async () => {
    configureLocal({ modelId: 'qwen3-asr-1.7b-gguf' })
    await refreshModeStatus()
    expect(getModeStatus().ready).toBe(true)

    state.invoke.mockImplementation(async (command: string) => {
      if (command === 'list_downloaded_models') throw new Error('ipc boom')
      throw new Error(`Unexpected command: ${command}`)
    })
    await refreshModeStatus()

    expect(getModeStatus()).toMatchObject({
      ready: false,
      blockedReason: 'modeStatus.modelListUnavailable',
      detail: 'localModel.qwen17Accurate.name',
    })
  })

  it('updates readiness when switching modes', async () => {
    configureLocal()
    await refreshModeStatus()
    expect(getModeStatus()).toMatchObject({ mode: 'local', ready: true })

    state.settings.set('workMode', 'server')
    await refreshModeStatus()
    expect(getModeStatus()).toMatchObject({ mode: 'server', ready: null, detail: '', blockedReason: '' })
  })

  it('shows a localized provider label and readiness for a valid keyless custom endpoint', async () => {
    const profile = {
      provider: 'openai_compat',
      baseUrl: 'http://localhost:8090/v1',
      model: 'local-model',
      apiKey: '',
    }
    state.settings.set('workMode', 'cloud_api')
    state.loadAsrProfiles.mockResolvedValue({ profiles: [profile], activeId: 'custom' })
    vi.mocked(resolveActiveAsrProfile).mockReturnValue(profile as never)
    vi.mocked(findAsrProvider).mockReturnValue({ customEndpoint: true } as never)
    vi.mocked(describeAsrMissing).mockReturnValue('')

    await refreshModeStatus()

    expect(getModeStatus()).toMatchObject({
      mode: 'cloud_api',
      detail: 'asrProvider.openaiCompat',
      ready: true,
      blockedReason: '',
    })
  })

  it('uses the catalog label for a provider without a curated short name', async () => {
    const profile = {
      provider: 'deepgram',
      baseUrl: '',
      model: 'nova-3',
      apiKey: 'deepgram-key',
    }
    state.settings.set('workMode', 'cloud_api')
    state.loadAsrProfiles.mockResolvedValue({ profiles: [profile], activeId: 'deepgram-account' })
    vi.mocked(resolveActiveAsrProfile).mockReturnValue(profile as never)
    vi.mocked(findAsrProvider).mockReturnValue({ label: 'asrProvider.deepgram' } as never)
    vi.mocked(describeAsrMissing).mockReturnValue('')

    await refreshModeStatus()

    expect(getModeStatus()).toMatchObject({
      mode: 'cloud_api',
      detail: 'asrProvider.deepgram',
      ready: true,
    })
  })
})

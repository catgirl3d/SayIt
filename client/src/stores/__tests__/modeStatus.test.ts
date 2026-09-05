import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: state.invoke }))
vi.mock('../../services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => state.settings.get(key) ?? fallback),
}))
vi.mock('../../features/settings/asrProviderCatalog', () => ({
  describeAsrMissing: vi.fn(),
  findAsrProvider: vi.fn(),
  resolveActiveAsrProfile: vi.fn(),
}))
vi.mock('@/i18n', () => ({
  subscribeLocale: vi.fn(() => () => {}),
  t: vi.fn((key: string) => key),
}))

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
  })

  it('keeps an ordinary complete model ready with auto', async () => {
    configureLocal()

    await refreshModeStatus()

    expect(getModeStatus().ready).toBe(true)
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

  it('updates readiness when switching modes', async () => {
    configureLocal()
    await refreshModeStatus()
    expect(getModeStatus()).toMatchObject({ mode: 'local', ready: true })

    state.settings.set('workMode', 'server')
    await refreshModeStatus()
    expect(getModeStatus()).toMatchObject({ mode: 'server', ready: null, detail: '', blockedReason: '' })
  })
})

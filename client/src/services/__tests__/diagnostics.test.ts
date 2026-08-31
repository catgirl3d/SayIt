import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  settings: new Map<string, unknown>(),
  mode: 'cloud_api' as 'local' | 'server' | 'cloud_api',
}))

const bridge = vi.hoisted(() => ({
  getDiagnosticsPreview: vi.fn(),
  createPublicDiagnosticsBundle: vi.fn(),
  copyDiagnosticsZip: vi.fn(),
}))

vi.mock('@/services/bridge', () => bridge)
vi.mock('@/services/store', () => ({
  getSetting: vi.fn(async (key: string, fallback: unknown) => state.settings.get(key) ?? fallback),
}))
vi.mock('@/services/speechInputLanguage', () => ({
  getSpeechInputLanguage: vi.fn(async () => state.settings.get('speechInput.language') ?? 'auto'),
}))
vi.mock('@/services/transcription', () => ({
  getWorkMode: vi.fn(() => state.mode),
}))

import {
  collectPublicDiagnosticsEnvironment,
  createSupportBundle,
  getDiagnosticsPreview,
  saveSupportBundle,
} from '../diagnostics'

describe('public diagnostics', () => {
  beforeEach(() => {
    state.settings.clear()
    state.mode = 'cloud_api'
    bridge.getDiagnosticsPreview.mockReset()
    bridge.createPublicDiagnosticsBundle.mockReset()
    bridge.copyDiagnosticsZip.mockReset()
  })

  it('sends only safe categorical environment values', async () => {
    state.settings.set('speechInput.language', 'uk')
    state.settings.set('aiEnabled', true)
    state.settings.set('cloudAsr.provider', 'qwen')
    state.settings.set('cloudAi.provider', 'openai_compat')
    state.settings.set('localAsr.accelerator', 'cuda')
    state.settings.set('cloudAi.apiKey', 'secret')
    state.settings.set('cloudAi.apiUrl', 'https://private.example')
    state.settings.set('cloudAi.model', 'private-model')
    state.settings.set('prompt', 'private prompt')
    state.settings.set('hotwords', ['private word'])
    state.settings.set('microphone.deviceId', 'private-mic')

    const environment = await collectPublicDiagnosticsEnvironment()

    expect(environment).toEqual({
      workMode: 'cloud_api',
      speechInputLanguage: 'uk',
      aiEnabled: true,
      asrProvider: 'cloud',
      aiProvider: 'cloud',
      localAccelerator: 'cuda',
    })
    expect(Object.keys(environment)).toEqual([
      'workMode',
      'speechInputLanguage',
      'aiEnabled',
      'asrProvider',
      'aiProvider',
      'localAccelerator',
    ])
    expect(JSON.stringify(environment)).not.toMatch(/secret|private|model|prompt|hotword|mic|https/)
  })

  it('uses none for disabled AI and unknown for invalid categories', async () => {
    state.mode = 'server'
    state.settings.set('aiEnabled', false)
    state.settings.set('localAsr.accelerator', 'metal')
    expect(await collectPublicDiagnosticsEnvironment()).toMatchObject({
      workMode: 'server',
      asrProvider: 'server',
      aiProvider: 'none',
      localAccelerator: 'unknown',
    })
  })

  it('classifies Groq as a cloud AI provider in local mode', async () => {
    state.mode = 'local'
    state.settings.set('aiEnabled', true)
    state.settings.set('cloudAi.provider', 'groq')

    expect(await collectPublicDiagnosticsEnvironment()).toMatchObject({
      workMode: 'local',
      asrProvider: 'local',
      aiProvider: 'cloud',
    })
  })

  it('creates and saves through bridge methods without a network path', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    bridge.createPublicDiagnosticsBundle.mockResolvedValue('/tmp/support.zip')
    bridge.copyDiagnosticsZip.mockResolvedValue(undefined)
    await createSupportBundle('today')
    expect(bridge.createPublicDiagnosticsBundle).toHaveBeenCalledWith({
      issueOccurrence: 'today',
      environment: {
        workMode: 'cloud_api',
        speechInputLanguage: 'auto',
        aiEnabled: false,
        asrProvider: 'cloud',
        aiProvider: 'none',
        localAccelerator: 'auto',
      },
    })
    await saveSupportBundle('today', 'C:/support.zip')
    expect(bridge.copyDiagnosticsZip).toHaveBeenCalledWith('/tmp/support.zip', 'C:/support.zip')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('propagates bundle failure without attempting a local copy', async () => {
    bridge.createPublicDiagnosticsBundle.mockRejectedValue(new Error('internal failure'))
    await expect(createSupportBundle('just_now')).rejects.toThrow('internal failure')
    expect(bridge.copyDiagnosticsZip).not.toHaveBeenCalled()
  })

  it('rejects a missing diagnostics preview', async () => {
    bridge.getDiagnosticsPreview.mockResolvedValue(null)

    await expect(getDiagnosticsPreview('today')).rejects.toThrow('Failed to collect diagnostics preview')
  })
})

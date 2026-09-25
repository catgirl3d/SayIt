import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  testAsrConnection: vi.fn(),
  getSetting: vi.fn(),
  getSpeechInputLanguage: vi.fn(),
}))

vi.mock('@/services/diagnostics', () => ({
  getDiagnosticsPreview: vi.fn(),
  saveSupportBundle: vi.fn(),
  testAsrConnection: (...args: unknown[]) => mocks.testAsrConnection(...args),
}))
vi.mock('@/services/store', () => ({ getSetting: (...args: unknown[]) => mocks.getSetting(...args) }))
vi.mock('@/services/transcription', () => ({ getWorkMode: vi.fn(() => 'cloud_api') }))
vi.mock('@/services/speechInputLanguage', () => ({
  getSpeechInputLanguage: (...args: unknown[]) => mocks.getSpeechInputLanguage(...args),
}))
vi.mock('@/features/settings/asrProfileStore', () => ({ loadActiveAsrProfile: vi.fn() }))
vi.mock('@/features/settings/DiagnosticsReportPanel', () => ({ default: () => null }))

import * as diagnosticsPage from '../DiagnosticsPage'
import { emptyAsrProfile } from '../asrProviderCatalog'

const checkCloudAsrHealth = Reflect.get(diagnosticsPage, 'checkCloudAsrHealth') as (
  profile: ReturnType<typeof emptyAsrProfile>,
) => Promise<{ status: string; detail: string }>

describe('passive cloud ASR diagnostics', () => {
  beforeEach(() => {
    mocks.testAsrConnection.mockReset()
    mocks.getSetting.mockReset()
    mocks.getSpeechInputLanguage.mockReset()
    mocks.testAsrConnection.mockResolvedValue({ ok: true, message: '' })
    mocks.getSpeechInputLanguage.mockResolvedValue('uk')
  })

  it('does not send audio for new providers checked by mount or Refresh', async () => {
    for (const provider of ['openai_transcribe', 'gemini_transcribe', 'openrouter_transcribe']) {
      const item = await checkCloudAsrHealth({ ...emptyAsrProfile(provider), apiKey: 'test-key' })
      expect(item.status).toBe('unknown')
      expect(item.detail).toBeTruthy()
    }
    expect(mocks.testAsrConnection).not.toHaveBeenCalled()
  })

  it('treats a valid keyless custom endpoint as unknown without sending billable audio', async () => {
    const profile = {
      ...emptyAsrProfile('openai_compat'),
      baseUrl: 'http://localhost:8090/v1',
      model: 'local-model',
      apiKey: '',
    }

    await expect(checkCloudAsrHealth(profile)).resolves.toMatchObject({
      status: 'unknown',
      detail: expect.stringContaining('Test from ASR settings'),
    })
    expect(mocks.testAsrConnection).not.toHaveBeenCalled()
  })

  it('keeps existing automatic checks and missing-key errors', async () => {
    const groq = { ...emptyAsrProfile('groq_whisper'), apiKey: 'groq-key' }
    await expect(checkCloudAsrHealth(groq)).resolves.toMatchObject({ status: 'ok' })
    expect(mocks.testAsrConnection).toHaveBeenCalledWith(groq, 'uk')

    mocks.testAsrConnection.mockClear()
    const missingKey = await checkCloudAsrHealth(emptyAsrProfile('openai_transcribe'))
    expect(missingKey.status).toBe('error')
    expect(mocks.testAsrConnection).not.toHaveBeenCalled()
  })
})

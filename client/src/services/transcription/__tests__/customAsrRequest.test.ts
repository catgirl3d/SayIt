import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { emptyAsrProfile, type AsrProfile } from '@/features/settings/asrProviderCatalog'
import CloudAPISection from '@/features/settings/CloudAPISection'
import { describeProviderError } from '@/lib/errorMessages'
import en from '@/i18n/locales/en.json'
import uk from '@/i18n/locales/uk.json'

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }))
const hookStateOverrides = vi.hoisted(() => ({ values: [] as unknown[] }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initialValue: T) => {
      if (hookStateOverrides.values.length > 0) {
        return [hookStateOverrides.values.shift() as T, () => {}]
      }
      return actual.useState(initialValue)
    },
    useLayoutEffect: () => undefined,
  }
})

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>()
  return { ...actual, createPortal: (children: ReactNode) => children }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))

import { transcribeCustomAsr } from '../customAsrRequest'

type CapturedRequest = {
  audio_b64: string
  sample_rate: number
  hotwords: string[]
  asr_config: {
    provider: string
    api_key: string
    app_id: string
    extra?: Record<string, unknown>
  }
}

function customProfile(overrides: Partial<AsrProfile> = {}): AsrProfile {
  return {
    ...emptyAsrProfile('openai_compat'),
    id: 'custom-account-a',
    baseUrl: 'http://localhost:8090/v1',
    model: 'audio-model-a',
    apiKey: 'custom-key-a',
    protocol: 'transcriptions',
    ...overrides,
  }
}

function input(profile: AsrProfile, isCurrent = () => true) {
  return {
    profile,
    audioB64: 'captured-audio-base64',
    sampleRate: 16000,
    language: 'uk' as const,
    hotwords: ['SayIt'],
    isCurrent,
  }
}

describe('custom ASR native request dispatch', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    hookStateOverrides.values = []
  })

  afterEach(() => vi.unstubAllGlobals())

  it('sends explicit transcriptions exactly once', async () => {
    invokeMock.mockResolvedValue({ text: 'transcribed', elapsed_ms: 12 })

    await expect(transcribeCustomAsr(input(customProfile()))).resolves.toEqual({
      text: 'transcribed',
      elapsed_ms: 12,
    })

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0]).toMatchObject([
      'cloud_transcribe',
      {
        request: {
          audio_b64: 'captured-audio-base64',
          sample_rate: 16000,
          hotwords: ['SayIt'],
          asr_config: {
            provider: 'openai_compat',
            api_key: 'custom-key-a',
            extra: {
              base_url: 'http://localhost:8090/v1',
              model: 'audio-model-a',
              protocol: 'transcriptions',
              language: 'uk',
            },
          },
        },
      },
    ])
  })

  it('sends explicit chat exactly once', async () => {
    invokeMock.mockResolvedValue({ text: 'chat transcript', elapsed_ms: 20 })

    await transcribeCustomAsr(input(customProfile({ protocol: 'chat' })))

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0][1]).toMatchObject({
      request: { asr_config: { extra: { protocol: 'chat' } } },
    })
  })

  it('Auto sends chat only after the reserved route mismatch and reuses the captured request', async () => {
    invokeMock
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'chat transcript', elapsed_ms: 30 })
    const profile = customProfile({ protocol: 'auto', model: 'auto-fallback-model' })
    const hotwords = ['SayIt']
    const request = { ...input(profile), hotwords }

    const pending = transcribeCustomAsr(request)
    profile.baseUrl = 'https://other.example.test/v1'
    profile.model = 'changed-model'
    profile.apiKey = 'changed-key'
    hotwords[0] = 'Changed'

    await expect(pending).resolves.toMatchObject({ text: 'chat transcript' })
    expect(invokeMock).toHaveBeenCalledTimes(2)

    const first = invokeMock.mock.calls[0][1] as { request: CapturedRequest }
    const second = invokeMock.mock.calls[1][1] as { request: CapturedRequest }
    expect(first.request).toMatchObject({
      audio_b64: 'captured-audio-base64',
      hotwords: ['SayIt'],
      asr_config: {
        api_key: 'custom-key-a',
        extra: { base_url: 'http://localhost:8090/v1', model: 'auto-fallback-model', protocol: 'transcriptions' },
      },
    })
    expect(second.request).toEqual({
      ...first.request,
      asr_config: {
        ...first.request.asr_config,
        extra: { ...first.request.asr_config.extra, protocol: 'chat' },
      },
    })
  })

  it('reuses the successful protocol for the same profile and normalized endpoint key', async () => {
    invokeMock
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'first chat transcript', elapsed_ms: 31 })
      .mockResolvedValueOnce({ text: 'cached chat transcript', elapsed_ms: 12 })
    const firstProfile = customProfile({
      id: 'cache-normalized-profile',
      baseUrl: 'HTTP://LOCALHOST:8090/v1/audio/transcriptions/',
      model: 'cache-normalized-model',
      protocol: 'auto',
    })

    await transcribeCustomAsr(input(firstProfile))
    await transcribeCustomAsr(input({ ...firstProfile, baseUrl: 'http://localhost:8090/v1/chat/completions' }))

    expect(invokeMock).toHaveBeenCalledTimes(3)
    expect(invokeMock.mock.calls.map(([, args]) => (
      (args as { request: CapturedRequest }).request.asr_config.extra?.protocol
    ))).toEqual(['transcriptions', 'chat', 'chat'])
  })

  it('caches a successful initial transcriptions request for the next Auto run', async () => {
    invokeMock
      .mockResolvedValueOnce({ text: 'first multipart transcript', elapsed_ms: 18 })
      .mockResolvedValueOnce({ text: 'cached multipart transcript', elapsed_ms: 11 })
    const profile = customProfile({
      id: 'cache-multipart-success-profile',
      model: 'cache-multipart-success-model',
      protocol: 'auto',
    })

    await transcribeCustomAsr(input(profile))
    await transcribeCustomAsr(input(profile))

    expect(invokeMock).toHaveBeenCalledTimes(2)
    expect(invokeMock.mock.calls.map(([, args]) => (
      (args as { request: CapturedRequest }).request.asr_config.extra?.protocol
    ))).toEqual(['transcriptions', 'transcriptions'])
  })

  it('does not reuse a successful protocol across different profile IDs', async () => {
    invokeMock
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'first chat transcript', elapsed_ms: 31 })
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'second chat transcript', elapsed_ms: 30 })
    const profile = customProfile({
      id: 'cache-profile-id-a',
      model: 'cache-profile-id-model',
      protocol: 'auto',
    })

    await transcribeCustomAsr(input(profile))
    await transcribeCustomAsr(input({ ...profile, id: 'cache-profile-id-b' }))

    expect(invokeMock.mock.calls.map(([, args]) => (
      (args as { request: CapturedRequest }).request.asr_config.extra?.protocol
    ))).toEqual(['transcriptions', 'chat', 'transcriptions', 'chat'])
  })

  it('does not reuse a successful protocol after the custom URL or model changes', async () => {
    invokeMock
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'first chat transcript', elapsed_ms: 31 })
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'second chat transcript', elapsed_ms: 30 })
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'third chat transcript', elapsed_ms: 29 })
    const profile = customProfile({
      id: 'cache-route-change-profile',
      model: 'cache-route-change-model-a',
      protocol: 'auto',
    })

    await transcribeCustomAsr(input(profile))
    await transcribeCustomAsr(input({ ...profile, baseUrl: 'http://localhost:8091/v1' }))
    await transcribeCustomAsr(input({ ...profile, baseUrl: 'http://localhost:8091/v1', model: 'cache-route-change-model-b' }))

    expect(invokeMock.mock.calls.map(([, args]) => (
      (args as { request: CapturedRequest }).request.asr_config.extra?.protocol
    ))).toEqual(['transcriptions', 'chat', 'transcriptions', 'chat', 'transcriptions', 'chat'])
  })

  it('does not cache failed fallback and never probes again after a cached protocol fails', async () => {
    const cachedProfile = customProfile({
      id: 'cache-failure-profile',
      model: 'cache-failure-model',
      protocol: 'auto',
    })
    const chatFailure = 'sayit_error:provider_bad_key:chat credentials rejected'
    invokeMock
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockRejectedValueOnce(chatFailure)
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'chat transcript', elapsed_ms: 28 })
      .mockRejectedValueOnce('sayit_error:provider_rate_limit:chat quota exhausted')

    await expect(transcribeCustomAsr(input(cachedProfile))).rejects.toBe(chatFailure)
    await transcribeCustomAsr(input(cachedProfile))
    await expect(transcribeCustomAsr(input(cachedProfile))).rejects.toBe('sayit_error:provider_rate_limit:chat quota exhausted')

    expect(invokeMock.mock.calls.map(([, args]) => (
      (args as { request: CapturedRequest }).request.asr_config.extra?.protocol
    ))).toEqual(['transcriptions', 'chat', 'transcriptions', 'chat', 'chat'])
  })

  it('does not cache a successful chat response if the run was cancelled before settlement', async () => {
    const profile = customProfile({
      id: 'cache-cancelled-result-profile',
      model: 'cache-cancelled-result-model',
      protocol: 'auto',
    })
    let resolveChat!: (result: { text: string; elapsed_ms: number }) => void
    let chatStarted!: () => void
    const chatRequestStarted = new Promise<void>((resolve) => { chatStarted = resolve })
    invokeMock.mockImplementationOnce(async () => {
      throw 'sayit_error:asr_protocol_mismatch:route mismatch'
    }).mockImplementationOnce(() => {
      chatStarted()
      return new Promise((resolve) => { resolveChat = resolve })
    }).mockResolvedValueOnce({ text: 'fresh multipart transcript', elapsed_ms: 14 })
    let current = true

    const cancelled = transcribeCustomAsr(input(profile, () => current))
    await chatRequestStarted
    current = false
    resolveChat({ text: 'late chat transcript', elapsed_ms: 35 })
    await expect(cancelled).resolves.toBeNull()

    await transcribeCustomAsr(input(profile))
    expect(invokeMock.mock.calls.map(([, args]) => (
      (args as { request: CapturedRequest }).request.asr_config.extra?.protocol
    ))).toEqual(['transcriptions', 'chat', 'transcriptions'])
  })

  it('makes explicit protocols ignore the Auto cache and send only the selected route', async () => {
    const autoProfile = customProfile({
      id: 'cache-explicit-profile',
      model: 'cache-explicit-model',
      protocol: 'auto',
    })
    invokeMock
      .mockRejectedValueOnce('sayit_error:asr_protocol_mismatch:route mismatch')
      .mockResolvedValueOnce({ text: 'cached chat transcript', elapsed_ms: 30 })
      .mockResolvedValueOnce({ text: 'explicit multipart transcript', elapsed_ms: 20 })
      .mockResolvedValueOnce({ text: 'explicit chat transcript', elapsed_ms: 19 })
      .mockResolvedValueOnce({ text: 'cached chat transcript', elapsed_ms: 12 })

    await transcribeCustomAsr(input(autoProfile))
    await transcribeCustomAsr(input({ ...autoProfile, protocol: 'transcriptions' }))
    await transcribeCustomAsr(input({ ...autoProfile, protocol: 'chat' }))
    await transcribeCustomAsr(input(autoProfile))

    expect(invokeMock.mock.calls.map(([, args]) => (
      (args as { request: CapturedRequest }).request.asr_config.extra?.protocol
    ))).toEqual(['transcriptions', 'chat', 'transcriptions', 'chat', 'chat'])
  })

  it.each([
    ['generic 404', 'sayit_error:connect_failed:endpoint path or model unavailable; verify URL/model', 'connect_failed'],
    ['model not found', 'sayit_error:provider_no_model:model not found', 'provider_no_model'],
    ['invalid audio', 'sayit_error:connect_failed:HTTP 422 invalid audio', 'connect_failed'],
    ['authentication failure', 'sayit_error:provider_bad_key:credentials rejected', 'provider_bad_key'],
    ['balance failure (HTTP 402)', 'sayit_error:provider_rate_limit:HTTP 402 payment required', 'provider_rate_limit'],
    ['quota failure (HTTP 429)', 'sayit_error:provider_rate_limit:HTTP 429 quota exhausted', 'provider_rate_limit'],
    ['server failure', 'sayit_error:connect_failed:HTTP 503 service unavailable', 'connect_failed'],
    ['timeout', 'sayit_error:provider_timeout:request deadline elapsed', 'provider_timeout'],
    ['network failure', 'sayit_error:provider_unreachable:connection refused', 'provider_unreachable'],
    ['malformed reply', 'sayit_error:connect_failed:malformed transcription response', 'connect_failed'],
    ['unstructured route wording', 'route not found', 'connect_failed'],
  ])('preserves the original error and friendly category without retry after %s', async (label, error, category) => {
    invokeMock.mockImplementationOnce(async () => { throw error })

    const outcome = await transcribeCustomAsr(
      input(customProfile({ protocol: 'auto', model: `terminal-${label}` })),
    ).then((value) => ({ value }), (caught: unknown) => ({ error: caught }))
    if (!('error' in outcome)) throw new Error('Auto unexpectedly succeeded after a terminal failure')
    expect(outcome.error).toBe(error)
    expect(describeProviderError(outcome.error).code).toBe(category)
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('does not mutate an Error object containing a stable provider classification', async () => {
    const originalError = new Error('sayit_error:provider_bad_key:credentials rejected')
    invokeMock.mockImplementationOnce(async () => { throw originalError })

    const outcome = await transcribeCustomAsr(input(customProfile({ protocol: 'auto', model: 'auth-envelope' })))
      .then((value) => ({ value }), (error: unknown) => ({ error }))
    if (!('error' in outcome)) throw new Error('Auto unexpectedly succeeded after authentication failure')

    expect(outcome.error).toBe(originalError)
    expect(originalError.message).toBe('sayit_error:provider_bad_key:credentials rejected')
    expect(describeProviderError(outcome.error).code).toBe('provider_bad_key')
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the Auto risk and manual Chat guidance localized in English and Ukrainian', () => {
    expect(en['asr.protocolAuto']).toMatch(/first request may be charged/i)
    expect(en['asr.protocolAutoHelp']).toMatch(/Auto uses real audio requests for protocol detection/i)
    expect(en['asr.protocolAutoHelp']).toMatch(/both the initial and later requests may be billable, depending on the provider/i)
    expect(en['asr.protocolAutoHelp']).toMatch(/select Chat manually/i)
    expect(uk['asr.protocolAuto']).toMatch(/перший запит може бути платним/i)
    expect(uk['asr.protocolAutoHelp']).toMatch(/автовизначення протоколу використовує реальні аудіозапити/i)
    expect(uk['asr.protocolAutoHelp']).toMatch(/початковий і наступні запити можуть бути платними залежно від провайдера/i)
    expect(uk['asr.protocolAutoHelp']).toMatch(/виберіть Chat вручну/i)
  })

  it('renders Auto help and associates the custom protocol Select with its visible label', () => {
    const profile = customProfile({ protocol: 'auto' })
    hookStateOverrides.values = [
      [],
      '',
      true,
      '',
      null,
      '',
      null,
      [],
      profile,
      false,
      JSON.stringify(profile),
      false,
      false,
    ]
    vi.stubGlobal('document', { body: {} })

    const markup = renderToStaticMarkup(createElement(CloudAPISection, { speechLanguage: 'uk' }))

    expect(markup).toContain('id="asr-custom-protocol-label"')
    expect(markup).toContain('aria-labelledby="asr-custom-protocol-label"')
    expect(markup).toContain(`>${en['asr.protocolAutoHelp']}</p>`)
  })

  it('distinguishes local and remote HTTP key warnings in English and Ukrainian', () => {
    expect(en['asr.customHttpKeyWarningLocal']).toMatch(/keeps traffic on this device.*still leaves.*unencrypted/i)
    expect(en['asr.customHttpKeyWarningRemote']).toMatch(/unencrypted across the network/i)
    expect(uk['asr.customHttpKeyWarningLocal']).toMatch(/трафік у межах пристрою.*не шифрує/i)
    expect(uk['asr.customHttpKeyWarningRemote']).toMatch(/не шифрує.*мереж/i)
  })

  it('does not dispatch chat when cancellation happens while the first request is pending', async () => {
    let rejectFirst!: (error: string) => void
    invokeMock.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject }))
    let current = true

    const pending = transcribeCustomAsr(input(customProfile({ protocol: 'auto', model: 'cancel-before-chat' }), () => current))
    const result = expect(pending).resolves.toBeNull()
    current = false
    rejectFirst('sayit_error:asr_protocol_mismatch:route mismatch')

    await result
    expect(invokeMock).toHaveBeenCalledTimes(1)
  })

  it('ignores a chat result if cancellation happens after its dispatch', async () => {
    let resolveChat!: (result: { text: string; elapsed_ms: number }) => void
    let startChat!: () => void
    const chatStarted = new Promise<void>((resolve) => { startChat = resolve })
    invokeMock.mockImplementationOnce(async () => {
      throw 'sayit_error:asr_protocol_mismatch:route mismatch'
    }).mockImplementationOnce(() => {
      startChat()
      return new Promise((resolve) => { resolveChat = resolve })
    })
    let current = true

    const pending = transcribeCustomAsr(input(customProfile({ protocol: 'auto', model: 'cancel-after-chat' }), () => current))
    await chatStarted
    current = false
    resolveChat({ text: 'late transcript', elapsed_ms: 40 })

    await expect(pending).resolves.toBeNull()
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })

  it('ignores a chat failure if cancellation happens after its dispatch', async () => {
    let rejectChat!: (reason: Error) => void
    let startChat!: () => void
    const chatStarted = new Promise<void>((resolve) => { startChat = resolve })
    invokeMock.mockImplementationOnce(async () => {
      throw 'sayit_error:asr_protocol_mismatch:route mismatch'
    }).mockImplementationOnce(() => {
      startChat()
      return new Promise((_resolve, reject) => { rejectChat = reject })
    })
    let current = true

    const pending = transcribeCustomAsr(input(customProfile({ protocol: 'auto', model: 'cancel-chat-error' }), () => current))
    await chatStarted
    current = false
    rejectChat(new Error('late chat failure'))

    await expect(pending).resolves.toBeNull()
    expect(invokeMock).toHaveBeenCalledTimes(2)
  })
})

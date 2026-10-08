import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
  polishWithClientAi: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }))
vi.mock('@/services/store', () => ({ getSetting: (...args: unknown[]) => mocks.getSetting(...args) }))
vi.mock('@/features/settings/asrProfileStore', () => ({
  loadActiveAsrProfile: (...args: unknown[]) => mocks.loadActiveAsrProfile(...args),
}))
vi.mock('../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../clientAiPolish', () => ({
  polishWithClientAi: (...args: unknown[]) => mocks.polishWithClientAi(...args),
}))

import { CloudAPIProvider } from '../CloudAPIProvider'

describe('CloudAPIProvider selected-profile snapshots', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.getSetting.mockReset()
    mocks.loadActiveAsrProfile.mockReset()
    mocks.polishWithClientAi.mockReset()

    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'cloudAsr.provider') return 'openai_transcribe'
      if (key === 'cloudAsr.apiKey') return 'stale-runtime-key'
      if (key === 'cloudAsr.appId') return ''
      return fallback
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_transcribe' ? { text: 'recognized', elapsed_ms: 24 } : undefined
    ))
    mocks.polishWithClientAi.mockImplementation(async ({ asrText }: { asrText: string }) => ({
      llmText: asrText,
      llmMs: 0,
      aiSource: 'none',
      aiStatus: 'skipped',
    }))
  })

  it("uses each run's selected key and model, not stale runtime credentials", async () => {
    mocks.loadActiveAsrProfile
      .mockResolvedValueOnce({
        id: 'account-a',
        provider: 'openai_transcribe',
        apiKey: 'key-account-a',
        appId: '',
        model: 'gpt-transcribe',
        omniPrompt: '',
      })
      .mockResolvedValueOnce({
        id: 'account-b',
        provider: 'openai_transcribe',
        apiKey: 'key-account-b',
        appId: '',
        model: 'whisper-1',
        omniPrompt: '',
      })

    const provider = new CloudAPIProvider()
    const results: Array<{ asrModel?: string }> = []
    let resolveDone = () => {}
    await provider.connect({
      onFinal: (result) => results.push(result),
      onDone: () => resolveDone(),
    })

    for (const runId of [1, 2]) {
      const done = new Promise<void>((resolve) => { resolveDone = resolve })
      expect(provider.start({ runId, language: 'uk' })).toBe(true)
      provider.sendAudio(new ArrayBuffer(16000))
      expect(provider.stop()).toBe(true)
      await done
    }

    const requests = mocks.invoke.mock.calls
      .filter(([command]) => command === 'cloud_transcribe')
      .map(([, args]) => (args as { request: { asr_config: Record<string, unknown> } }).request.asr_config)

    expect(requests).toEqual([
      {
        provider: 'openai_transcribe',
        api_key: 'key-account-a',
        app_id: '',
        extra: { model: 'gpt-transcribe', language: 'uk' },
      },
      {
        provider: 'openai_transcribe',
        api_key: 'key-account-b',
        app_id: '',
        extra: { model: 'whisper-1', language: 'uk' },
      },
    ])
    expect(results.map((result) => result.asrModel)).toEqual(['gpt-transcribe', 'whisper-1'])
  })

  it('keeps a dictionary-limit fallback successful and delivers its warning with the recognized text', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({ id: 'dg', provider: 'deepgram', model: 'nova-3', apiKey: 'key', deepgramKeytermsEnabled: true })
    mocks.invoke.mockImplementation(async (command: string) => command === 'cloud_transcribe'
      ? { text: 'recognized', elapsed_ms: 24, warning: 'deepgram_keyterm_limit' } : undefined)
    const provider = new CloudAPIProvider()
    const onWarning = vi.fn()
    const onError = vi.fn()
    const onASR = vi.fn()
    const onFinal = vi.fn()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    await provider.connect({ onWarning, onError, onASR, onFinal, onDone: finish })
    provider.start({ runId: 20, hotwords: ['SayIt'], disableStreaming: true })
    provider.sendAudio(new ArrayBuffer(16000))
    provider.stop()
    await done
    expect(onWarning).toHaveBeenCalledExactlyOnceWith('deepgram_keyterm_limit')
    expect(onASR).toHaveBeenCalledWith(expect.objectContaining({ text: 'recognized', asrWarning: 'deepgram_keyterm_limit' }))
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ asrText: 'recognized', asrWarning: 'deepgram_keyterm_limit' }))
    expect(onError).not.toHaveBeenCalled()
  })

  it('does not forward a dictionary fallback warning from a canceled request', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({ id: 'dg', provider: 'deepgram', model: 'nova-3', apiKey: 'key' })
    let respond!: (value: unknown) => void
    mocks.invoke.mockImplementation(async (command: string) => command === 'cloud_transcribe'
      ? new Promise((resolve) => { respond = resolve }) : undefined)
    const provider = new CloudAPIProvider()
    const onWarning = vi.fn()
    const onFinal = vi.fn()
    await provider.connect({ onWarning, onFinal })
    provider.start({ runId: 21, disableStreaming: true })
    provider.sendAudio(new ArrayBuffer(16000))
    provider.stop()
    await vi.waitFor(() => expect(respond).toBeTypeOf('function'))
    provider.cancel()
    respond({ text: 'stale', elapsed_ms: 24, warning: 'deepgram_keyterm_limit' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onWarning).not.toHaveBeenCalled()
    expect(onFinal).not.toHaveBeenCalled()
  })

  it('uses a recovered live connection warning without a second buffered recognition', async () => {
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => key === 'streamingDisplayEnabled' ? true : fallback)
    mocks.loadActiveAsrProfile.mockResolvedValue({ id: 'dg', provider: 'deepgram', model: 'nova-3', apiKey: 'key', deepgramKeytermsEnabled: true })
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deepgram_stream_open') return 'deepgram_keyterm_limit'
      if (command === 'deepgram_stream_finish') return 'recognized'
    })
    const provider = new CloudAPIProvider()
    const onWarning = vi.fn()
    const onFinal = vi.fn()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    await provider.connect({ onWarning, onFinal, onDone: finish })
    provider.start({ runId: 22, hotwords: ['SayIt'] })
    provider.sendAudio(new ArrayBuffer(16000))
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_open')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 0))
    provider.stop()
    await done
    expect(onWarning).toHaveBeenCalledExactlyOnceWith('deepgram_keyterm_limit')
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ asrText: 'recognized', asrWarning: 'deepgram_keyterm_limit' }))
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(false)
    const sentFrames = mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')
    const sentBytes = sentFrames.reduce((total, [, args]) => (
      total + atob((args as { pcmB64: string }).pcmB64).length
    ), 0)
    expect(sentBytes).toBe(16000)
  })

  it('does not launch a third attempt when a live keyterm-limit retry fails before stop', async () => {
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => key === 'streamingDisplayEnabled' ? true : fallback)
    mocks.loadActiveAsrProfile.mockResolvedValue({ id: 'dg', provider: 'deepgram', model: 'nova-3', apiKey: 'key', deepgramKeytermsEnabled: true })
    let rejectOpen!: (value: unknown) => void
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deepgram_stream_open') return new Promise((_, reject) => { rejectOpen = reject })
      if (command === 'cloud_transcribe') return { text: 'unexpected third attempt', elapsed_ms: 24 }
    })
    const provider = new CloudAPIProvider()
    const onError = vi.fn()
    const onWarning = vi.fn()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    await provider.connect({ onError, onWarning, onDone: finish })
    provider.start({ runId: 23, hotwords: ['SayIt'] })
    provider.sendAudio(new ArrayBuffer(16000))
    await vi.waitFor(() => expect(rejectOpen).toBeTypeOf('function'))
    provider.stop()
    rejectOpen('sayit_error:deepgram_keyterm_retry_failed:Retry without dictionary failed')
    await done
    expect(onError).toHaveBeenCalledExactlyOnceWith('sayit_error:deepgram_keyterm_retry_failed:Retry without dictionary failed')
    expect(onWarning).not.toHaveBeenCalled()
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(false)
  })

  it('keeps an in-flight run bound to the profile captured at start', async () => {
    let resolveFirstProfile!: (profile: {
      id: string
      provider: string
      apiKey: string
      appId: string
      model: string
      omniPrompt: string
    }) => void
    const firstProfile = new Promise<{
      id: string
      provider: string
      apiKey: string
      appId: string
      model: string
      omniPrompt: string
    }>((resolve) => { resolveFirstProfile = resolve })
    mocks.loadActiveAsrProfile
      .mockReturnValueOnce(firstProfile)
      .mockResolvedValueOnce({
        id: 'account-b',
        provider: 'openai_transcribe',
        apiKey: 'key-account-b',
        appId: '',
        model: 'whisper-1',
        omniPrompt: '',
      })

    const provider = new CloudAPIProvider()
    const models: string[] = []
    let resolveDone = () => {}
    await provider.connect({
      onFinal: (result) => { if (result.asrModel) models.push(result.asrModel) },
      onDone: () => resolveDone(),
    })

    const firstDone = new Promise<void>((resolve) => { resolveDone = resolve })
    expect(provider.start({ runId: 1, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    resolveFirstProfile({
      id: 'account-a',
      provider: 'openai_transcribe',
      apiKey: 'key-account-a',
      appId: '',
      model: 'gpt-transcribe',
      omniPrompt: '',
    })
    await firstDone

    const secondDone = new Promise<void>((resolve) => { resolveDone = resolve })
    expect(provider.start({ runId: 2, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await secondDone

    const configs = mocks.invoke.mock.calls
      .filter(([command]) => command === 'cloud_transcribe')
      .map(([, args]) => (args as { request: { asr_config: { api_key: string; extra: { model: string } } } }).request.asr_config)
    expect(configs.map(({ api_key, extra }) => [api_key, extra.model])).toEqual([
      ['key-account-a', 'gpt-transcribe'],
      ['key-account-b', 'whisper-1'],
    ])
    expect(models).toEqual(['gpt-transcribe', 'whisper-1'])
  })

  it('does not send a request with stale runtime credentials when the profile snapshot fails', async () => {
    mocks.loadActiveAsrProfile.mockRejectedValueOnce(new Error('activation save failed'))
    const errors: string[] = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    const provider = new CloudAPIProvider()
    await provider.connect({
      onError: (error) => errors.push(error),
      onDone: () => resolveDone(),
    })

    expect(provider.start({ runId: 1, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await done

    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_transcribe')).toEqual([])
    expect(errors).toEqual(['Error: activation save failed'])
  })

  it('uses the custom profile snapshot for Auto and preserves provider/model on empty results', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'local-custom-asr',
      provider: 'openai_compat',
      baseUrl: 'http://localhost:8090/v1',
      apiKey: '',
      appId: '',
      model: 'local-whisper',
      protocol: 'auto',
      omniPrompt: '',
    })
    const calls: Array<{ asr_config: { extra?: Record<string, unknown> } }> = []
    mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
      if (command !== 'cloud_transcribe') return undefined
      const request = (args as { request: { asr_config: { extra?: Record<string, unknown> } } }).request
      calls.push(request)
      if (calls.length === 1) throw 'sayit_error:asr_protocol_mismatch:route mismatch'
      return { text: '', elapsed_ms: 15 }
    })

    const provider = new CloudAPIProvider()
    const asrResults: Array<{ asrEngine?: string; asrModel?: string }> = []
    const finalResults: Array<{ asrEngine?: string; asrModel?: string }> = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    await provider.connect({
      onASR: (result) => asrResults.push(result),
      onFinal: (result) => finalResults.push(result),
      onDone: () => resolveDone(),
    })

    expect(provider.start({ runId: 8, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await done

    expect(calls).toHaveLength(2)
    expect(calls.map((request) => request.asr_config.extra)).toEqual([
      { model: 'local-whisper', language: 'uk', base_url: 'http://localhost:8090/v1', protocol: 'transcriptions' },
      { model: 'local-whisper', language: 'uk', base_url: 'http://localhost:8090/v1', protocol: 'chat' },
    ])
    expect(asrResults[0]).toMatchObject({ asrEngine: 'openai_compat', asrModel: 'local-whisper' })
    expect(finalResults[0]).toMatchObject({ asrEngine: 'openai_compat', asrModel: 'local-whisper' })
  })

  it('stamps the snapshot engine and model for buffered profiles', async () => {
    const cases = [
      { id: 'qwen', model: 'qwen3-asr-flash' },
      { id: 'mimo', model: 'mimo-v2.5-asr' },
      { id: 'groq_whisper', model: 'whisper-large-v3-turbo' },
      { id: 'groq_whisper', model: 'whisper-large-v3' },
    ]
    const groqRequests: Array<{ extra?: Record<string, unknown> }> = []

    for (const { id, model } of cases) {
      mocks.invoke.mockReset()
      mocks.invoke.mockImplementation(async (command: string, args: unknown) => {
        if (command !== 'cloud_transcribe') return undefined
        const config = (args as { request: { asr_config: { provider: string; extra?: Record<string, unknown> } } }).request.asr_config
        if (config.provider === 'groq_whisper') groqRequests.push(config)
        return { text: 'recognized', elapsed_ms: 24 }
      })
      mocks.loadActiveAsrProfile.mockResolvedValue({
        id: `account-${id}`,
        provider: id,
        apiKey: 'key',
        appId: '',
        model,
        omniPrompt: '',
      })

      const provider = new CloudAPIProvider()
      const finals: Array<{ asrEngine?: string; asrModel?: string }> = []
      let resolveDone = () => {}
      const done = new Promise<void>((resolve) => { resolveDone = resolve })
      await provider.connect({ onFinal: (result) => finals.push(result), onDone: () => resolveDone() })

      expect(provider.start({ runId: 11, language: 'uk' })).toBe(true)
      provider.sendAudio(new ArrayBuffer(16000))
      expect(provider.stop()).toBe(true)
      await done

      expect(finals[0]).toMatchObject({ asrEngine: id, asrModel: model })
    }

    expect(groqRequests.map(({ extra }) => extra)).toEqual([
      { model: 'whisper-large-v3-turbo', language: 'uk' },
      { model: 'whisper-large-v3', language: 'uk' },
    ])
  })

  it('stamps the Doubao catalog model on a streamed result', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'doubao-account',
      provider: 'doubao_v2',
      apiKey: 'doubao-key',
      appId: '',
      model: 'Doubao-Seed-ASR-2.0',
      omniPrompt: '',
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'doubao_stream_finish' ? 'recognized' : undefined
    ))

    const provider = new CloudAPIProvider()
    const finals: Array<{ asrEngine?: string; asrModel?: string }> = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    await provider.connect({ onFinal: (result) => finals.push(result), onDone: () => resolveDone() })

    expect(provider.start({ runId: 12, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    // The Doubao stream opens asynchronously; stop only takes the streaming path once ready.
    await vi.waitFor(() => {
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'doubao_stream_open')).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.stop()).toBe(true)
    await done

    expect(finals[0]).toMatchObject({ asrEngine: 'doubao_v2', asrModel: 'Doubao-Seed-ASR-2.0' })
  })

  it('does not dispatch Auto chat after cancellation while multipart is pending', async () => {
    let rejectMultipart!: (reason: string) => void
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'cancel-custom-asr',
      provider: 'openai_compat',
      baseUrl: 'http://localhost:8090/v1',
      apiKey: 'cancel-key',
      appId: '',
      model: 'cancel-model',
      protocol: 'auto',
      omniPrompt: '',
    })
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'cloud_transcribe') {
        return new Promise((_resolve, reject) => { rejectMultipart = reject })
      }
      return Promise.resolve(undefined)
    })
    const callbacks = { onASR: vi.fn(), onFinal: vi.fn(), onError: vi.fn(), onDone: vi.fn() }
    const provider = new CloudAPIProvider()
    await provider.connect(callbacks)
    expect(provider.start({ runId: 9, language: 'uk' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)

    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(true))
    provider.cancel()
    rejectMultipart('sayit_error:asr_protocol_mismatch:route mismatch')
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(true))
    await Promise.resolve()

    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_transcribe')).toHaveLength(1)
    expect(callbacks.onASR).not.toHaveBeenCalled()
    expect(callbacks.onFinal).not.toHaveBeenCalled()
    expect(callbacks.onError).not.toHaveBeenCalled()
  })

  it('streams Deepgram through its own transport and stamps the catalog model', async () => {
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => (
      key === 'streamingDisplayEnabled' ? true : fallback
    ))
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-account',
      provider: 'deepgram',
      apiKey: 'deepgram-key',
      appId: '',
      model: 'nova-3',
      omniPrompt: '',
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'deepgram_stream_finish' ? 'recognized' : undefined
    ))

    const provider = new CloudAPIProvider()
    const finals: Array<{ asrEngine?: string; asrModel?: string }> = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    await provider.connect({ onFinal: (result) => finals.push(result), onDone: () => resolveDone() })

    expect(provider.start({ runId: 13, language: 'ru' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    // The Deepgram stream opens asynchronously; stop only takes the streaming path once ready.
    await vi.waitFor(() => {
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_open')).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Once ready, new audio must be pushed to the stream by the periodic flush,
    // not held until stop.
    provider.sendAudio(new ArrayBuffer(16000))
    await vi.waitFor(() => {
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_send')).toBe(true)
    }, { timeout: 2000 })
    expect(provider.stop()).toBe(true)
    await done

    const openCall = mocks.invoke.mock.calls.find(([command]) => command === 'deepgram_stream_open')
    expect(openCall?.[1]).toMatchObject({
      config: {
        provider: 'deepgram',
        api_key: 'deepgram-key',
        app_id: '',
        extra: { model: 'nova-3', language: 'ru' },
      },
      sampleRate: 16000,
    })
    expect(finals[0]).toMatchObject({ asrEngine: 'deepgram', asrModel: 'nova-3' })
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(false)
  })

  it('transcribes a completed Deepgram segment without opening a live socket when captions are off', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-account', provider: 'deepgram', apiKey: 'deepgram-key',
      appId: '', model: 'nova-3', omniPrompt: '',
    })
    const provider = new CloudAPIProvider()
    const finals: Array<{ asrText: string; asrEngine?: string }> = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    await provider.connect({ onFinal: (result) => finals.push(result), onDone: () => resolveDone() })

    expect(provider.start({ runId: 14, language: 'en', disableAi: true })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await done
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(finals).toEqual([expect.objectContaining({ asrText: 'recognized', asrEngine: 'deepgram' })])
    const requests = mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_transcribe')
    expect(requests).toHaveLength(1)
    expect(requests[0][1]).toMatchObject({ request: {
      sample_rate: 16000,
      asr_config: { provider: 'deepgram', extra: { model: 'nova-3', language: 'en' } },
    } })
    expect(mocks.invoke.mock.calls.some(([command]) => (
      command === 'deepgram_stream_open' || command === 'deepgram_stream_send' || command === 'deepgram_stream_finish'
    ))).toBe(false)
    provider.disconnect()
  })

  it('keeps subtitle segment runs on the HTTP path even when live captions are enabled', async () => {
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => (
      key === 'streamingDisplayEnabled' ? true : fallback
    ))
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-account', provider: 'deepgram', apiKey: 'deepgram-key',
      appId: '', model: 'nova-3', omniPrompt: '',
    })
    const provider = new CloudAPIProvider()
    const finals: Array<{ asrText: string }> = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    await provider.connect({ onFinal: (result) => finals.push(result), onDone: () => resolveDone() })

    expect(provider.start({ runId: 15, language: 'ru', disableStreaming: true })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    expect(provider.stop()).toBe(true)
    await done
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(mocks.invoke.mock.calls.some(([command]) => (
      command === 'deepgram_stream_open' || command === 'deepgram_stream_send' || command === 'deepgram_stream_finish'
    ))).toBe(false)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_transcribe')).toHaveLength(1)
    expect(finals).toEqual([expect.objectContaining({ asrText: 'recognized' })])
    provider.disconnect()
  })

  it('falls back to the buffered HTTP path when a Deepgram stream send fails', async () => {
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => (
      key === 'streamingDisplayEnabled' ? true : fallback
    ))
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-account', provider: 'deepgram', apiKey: 'deepgram-key',
      appId: '', model: 'nova-3', omniPrompt: '',
    })
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deepgram_stream_send') throw new Error('socket is gone')
      if (command === 'cloud_transcribe') return { text: 'recognized', elapsed_ms: 24 }
      return undefined
    })

    const provider = new CloudAPIProvider()
    const finals: Array<{ asrText: string }> = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    await provider.connect({ onFinal: (result) => finals.push(result), onDone: () => resolveDone() })

    expect(provider.start({ runId: 16, language: 'ru' })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    await vi.waitFor(() => {
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_open')).toBe(true)
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    // Queued after the stream is ready, so the periodic flush attempts to send it and fails.
    provider.sendAudio(new ArrayBuffer(16000))
    await vi.waitFor(() => {
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_send')).toBe(true)
    }, { timeout: 2000 })
    // Let the rejected send clear stream readiness before stopping.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.stop()).toBe(true)
    await done

    expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_finish')).toBe(false)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'cloud_transcribe')).toHaveLength(1)
    expect(finals).toEqual([expect.objectContaining({ asrText: 'recognized' })])
  })
})

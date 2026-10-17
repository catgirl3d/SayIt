import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  getSetting: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
  listen: vi.fn(),
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  eventOrder: [] as string[],
  boundaryOrder: [] as string[],
  polishWithClientAi: vi.fn(),
  addRuntimeEvent: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => {
    mocks.boundaryOrder.push(`invoke:${String(args[0])}`)
    return mocks.invoke(...args)
  },
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => {
    mocks.boundaryOrder.push(`listen:${String(args[0])}`)
    return mocks.listen(...args)
  },
}))
vi.mock('@/services/store', () => ({ getSetting: (...args: unknown[]) => mocks.getSetting(...args) }))
vi.mock('@/features/settings/asrProfileStore', () => ({
  loadActiveAsrProfile: (...args: unknown[]) => mocks.loadActiveAsrProfile(...args),
}))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: (...args: unknown[]) => mocks.addRuntimeEvent(...args) }))
vi.mock('../clientAiPolish', async (importOriginal) => ({
  ...await importOriginal<typeof import('../clientAiPolish')>(),
  polishWithClientAi: (...args: unknown[]) => mocks.polishWithClientAi(...args),
}))

import { CloudAPIProvider } from '../CloudAPIProvider'

describe('CloudAPIProvider selected-profile snapshots', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.getSetting.mockReset()
    mocks.loadActiveAsrProfile.mockReset()
    mocks.listen.mockReset()
    mocks.listeners.clear()
    mocks.eventOrder.length = 0
    mocks.boundaryOrder.length = 0
    mocks.polishWithClientAi.mockReset()
    mocks.addRuntimeEvent.mockReset()

    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'cloudAsr.provider') return 'openai_transcribe'
      if (key === 'cloudAsr.apiKey') return 'stale-runtime-key'
      if (key === 'cloudAsr.appId') return ''
      return fallback
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'cloud_transcribe' ? { text: 'recognized', elapsed_ms: 24 } : undefined
    ))
    mocks.listen.mockImplementation(async (
      eventName: string,
      handler: (event: { payload: unknown }) => void,
    ) => {
      mocks.eventOrder.push(eventName)
      const listeners = mocks.listeners.get(eventName) ?? new Set()
      listeners.add(handler)
      mocks.listeners.set(eventName, listeners)
      return () => listeners.delete(handler)
    })
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

  it('sends the selected speech language to the Qwen realtime session', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'qwen-account',
      provider: 'qwen_realtime',
      apiKey: 'qwen-key',
      appId: '',
      workspaceId: 'ws-test',
      model: '',
      omniPrompt: '',
    })
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'qwen_stream_finish' ? 'recognized' : undefined
    ))

    const provider = new CloudAPIProvider()
    const finals: Array<{ asrEngine?: string; asrText?: string }> = []
    let resolveDone = () => {}
    const done = new Promise<void>((resolve) => { resolveDone = resolve })
    await provider.connect({ onFinal: (result) => finals.push(result), onDone: () => resolveDone() })

    expect(provider.start({ runId: 21, language: 'uk', streamingDisplay: true })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    // The Qwen stream opens asynchronously; stop only takes the streaming path once ready.
    await vi.waitFor(() => {
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'qwen_stream_open')).toBe(true)
    })
    const openArgs = mocks.invoke.mock.calls.find(([command]) => command === 'qwen_stream_open')?.[1] as {
      language?: string
      realtime?: boolean
      workspaceId?: string
    }
    expect(openArgs.language).toBe('uk')
    expect(openArgs.realtime).toBe(true)
    expect(openArgs.workspaceId).toBe('ws-test')

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(provider.stop()).toBe(true)
    await done

    expect(finals[0]).toMatchObject({ asrEngine: 'qwen_realtime', asrText: 'recognized' })
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

  it('opens a tagged live session from one immutable Deepgram profile and forwards tagged events', async () => {
    const profile = {
      id: 'deepgram-live',
      provider: 'deepgram',
      apiKey: 'live-key',
      appId: '',
      console: 'new',
      otherKey: '',
      workspaceId: '',
      model: 'nova-3',
      omniPrompt: '',
      deepgramKeytermsEnabled: true,
    }
    mocks.loadActiveAsrProfile.mockResolvedValue(profile)
    mocks.invoke.mockImplementation(async (command: string) => (
      command === 'deepgram_stream_open' ? 'deepgram_keyterm_limit' : undefined
    ))
    const options = { runId: 50, language: 'uk', hotwords: ['SayIt'] }
    const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const provider = new CloudAPIProvider()
    const openPromise = provider.openLive(options, callbacks)
    options.hotwords[0] = 'mutated-caller-value'

    const session = await openPromise
    expect(session).not.toBeNull()
    expect(mocks.loadActiveAsrProfile).toHaveBeenCalledTimes(1)
    expect(mocks.getSetting).not.toHaveBeenCalled()
    expect(mocks.eventOrder).toEqual(['deepgram-live-result', 'deepgram-live-error'])
    expect(mocks.boundaryOrder.slice(0, 3)).toEqual([
      'listen:deepgram-live-result',
      'listen:deepgram-live-error',
      'invoke:deepgram_stream_open',
    ])
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_open')).toHaveLength(1)
    const openArgs = mocks.invoke.mock.calls.find(([command]) => command === 'deepgram_stream_open')?.[1]
    expect(openArgs).toMatchObject({
      config: {
        provider: 'deepgram',
        api_key: 'live-key',
        app_id: '',
        extra: { model: 'nova-3', language: 'uk', keyterms_enabled: true },
      },
      sampleRate: 16000,
      hotwords: ['SayIt'],
    })
    const sessionId = (openArgs as { sessionId: string }).sessionId
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(0)
    expect(callbacks.onWarning).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      code: 'deepgram_keyterm_limit',
      asrEngine: 'deepgram',
      asrModel: 'nova-3',
    })

    for (const listener of mocks.listeners.get('deepgram-live-result') ?? []) {
      listener({ payload: {
        sessionId,
        resultId: 7,
        audioStartMs: 1250,
        audioEndMs: 1500,
        text: '',
        isFinal: true,
        speechFinal: true,
        fromFinalize: true,
      } })
    }
    expect(callbacks.onResult).toHaveBeenCalledExactlyOnceWith({
      sessionId,
      resultId: 7,
      audioStartMs: 1250,
      audioEndMs: 1500,
      text: '',
      isFinal: true,
      speechFinal: true,
      fromFinalize: true,
      asrEngine: 'deepgram',
      asrModel: 'nova-3',
    })
    expect(profile.apiKey).toBe('live-key')
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(false)
    expect(mocks.polishWithClientAi).not.toHaveBeenCalled()
    await session?.close()
  })

  it('keeps a completed buffered run from closing the socket of an open live owner', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    const provider = new CloudAPIProvider()
    const liveCallbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const session = await provider.openLive({ runId: 72 }, liveCallbacks)
    expect(session).not.toBeNull()

    let finishRun!: () => void
    const runDone = new Promise<void>((resolve) => { finishRun = resolve })
    const onFinal = vi.fn()
    await provider.connect({ onFinal, onDone: finishRun })
    expect(provider.start({ runId: 73, disableStreaming: true })).toBe(true)
    provider.sendAudio(new ArrayBuffer(16000))
    provider.stop()
    await runDone

    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(true)
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ asrText: 'recognized' }))

    const sessionId = session?.sessionId
    for (const listener of mocks.listeners.get('deepgram-live-result') ?? []) {
      listener({ payload: {
        sessionId,
        resultId: 11,
        audioStartMs: 0,
        audioEndMs: 500,
        text: 'live text',
        isFinal: true,
        speechFinal: true,
        fromFinalize: false,
      } })
    }
    expect(liveCallbacks.onResult).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId, text: 'live text' }))
    expect(liveCallbacks.onError).not.toHaveBeenCalled()

    await session?.close()
    for (const command of ['doubao_stream_close', 'qwen_stream_close', 'qwen_audio_stream_close']) {
      expect(mocks.invoke.mock.calls.filter(([name]) => name === command)).toHaveLength(1)
    }
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toEqual([
      ['deepgram_stream_close', { sessionId }],
    ])
  })

  it('returns null for a known unsupported live profile without opening or using batch recognition', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'openai-profile', provider: 'openai_transcribe', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'whisper-1', omniPrompt: '',
    })
    const provider = new CloudAPIProvider()

    await expect(provider.openLive(
      { runId: 51 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )).resolves.toBeNull()

    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(mocks.polishWithClientAi).not.toHaveBeenCalled()
  })

  it('rejects a failed Deepgram live open instead of returning unsupported or falling back to HTTP', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deepgram_stream_open') throw new Error('Deepgram handshake failed')
      return undefined
    })
    const provider = new CloudAPIProvider()

    await expect(provider.openLive(
      { runId: 52 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )).rejects.toThrow('Deepgram handshake failed')

    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'deepgram_stream_open',
      'deepgram_stream_close',
    ])
    expect(mocks.invoke.mock.calls[1][1]).toEqual({ sessionId: expect.any(String) })
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(false)
    expect(mocks.polishWithClientAi).not.toHaveBeenCalled()
  })

  it('rejects stale live events after closing and opening a replacement session', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    const provider = new CloudAPIProvider()
    const oldCallbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const oldSession = await provider.openLive({ runId: 53 }, oldCallbacks)
    const oldHandler = [...(mocks.listeners.get('deepgram-live-result') ?? [])][0]
    await oldSession?.close()

    const newCallbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const newSession = await provider.openLive({ runId: 54 }, newCallbacks)
    const openCalls = mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_open')
    const newOpenArgs = openCalls[openCalls.length - 1]?.[1] as { sessionId: string }
    const staleResult = {
      sessionId: oldSession?.sessionId,
      resultId: 1,
      audioStartMs: 0,
      audioEndMs: 100,
      text: 'stale',
      isFinal: true,
      speechFinal: true,
      fromFinalize: false,
    }

    expect(newOpenArgs.sessionId).not.toBe(oldSession?.sessionId)
    expect(oldHandler).toBeTypeOf('function')
    oldHandler!({ payload: staleResult })
    expect(oldCallbacks.onResult).not.toHaveBeenCalled()

    const currentHandler = [...(mocks.listeners.get('deepgram-live-result') ?? [])][0]
    expect(currentHandler).toBeTypeOf('function')
    currentHandler!({ payload: staleResult })
    expect(newCallbacks.onResult).not.toHaveBeenCalled()
    const currentResult = { ...staleResult, sessionId: newOpenArgs.sessionId, resultId: 2, text: 'current' }
    currentHandler!({ payload: currentResult })
    expect(newCallbacks.onResult).toHaveBeenCalledExactlyOnceWith({
      ...currentResult,
      asrEngine: 'deepgram',
      asrModel: 'nova-3',
    })
    await newSession?.close()
  })

  it('sends bounded ordered audio with only one unresolved IPC send at a time', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    let releaseFirstSend!: () => void
    let activeSends = 0
    let totalSends = 0
    let maxActiveSends = 0
    mocks.invoke.mockImplementation((command: string) => {
      if (command !== 'deepgram_stream_send') return Promise.resolve(undefined)
      totalSends++
      activeSends++
      maxActiveSends = Math.max(maxActiveSends, activeSends)
      if (totalSends === 1) {
        return new Promise<void>((resolve) => {
          releaseFirstSend = () => {
            activeSends--
            resolve()
          }
        })
      }
      activeSends--
      return Promise.resolve(undefined)
    })
    const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const provider = new CloudAPIProvider()
    const session = await provider.openLive({ runId: 55 }, callbacks)
    const first = new Uint8Array(12000).fill(0x11)
    const second = new Uint8Array(8000).fill(0x22)
    const third = new Uint8Array(5000).fill(0x33)

    session?.sendAudio(first.slice().buffer)
    session?.sendAudio(second.slice().buffer)
    session?.sendAudio(third.slice().buffer)
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')).toHaveLength(1))
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')).toHaveLength(1)
    releaseFirstSend()
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')).toHaveLength(2))
    await session?.close()

    const sentBytes = mocks.invoke.mock.calls
      .filter(([command]) => command === 'deepgram_stream_send')
      .map(([, args]) => new Uint8Array(atob((args as { pcmB64: string }).pcmB64).split('').map((char) => char.charCodeAt(0))))
    const concatenated = new Uint8Array(sentBytes.reduce((sum, bytes) => sum + bytes.length, 0))
    let offset = 0
    for (const bytes of sentBytes) {
      concatenated.set(bytes, offset)
      offset += bytes.length
    }
    expect(concatenated).toEqual(new Uint8Array([...first, ...second, ...third]))
    expect(maxActiveSends).toBe(1)
    expect(mocks.invoke.mock.calls
      .filter(([command]) => command === 'deepgram_stream_send')
      .map(([, args]) => (args as { sessionId: string }).sessionId))
      .toEqual([session?.sessionId, session?.sessionId])
  })

  it('charges in-flight audio against the 384000-byte cap and makes overflow terminal', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    let releaseSend!: () => void
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'deepgram_stream_send') {
        return new Promise<void>((resolve) => { releaseSend = resolve })
      }
      return Promise.resolve(undefined)
    })
    const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const provider = new CloudAPIProvider()
    const session = await provider.openLive({ runId: 56 }, callbacks)

    session?.sendAudio(new ArrayBuffer(16000))
    await vi.waitFor(() => expect(releaseSend).toBeTypeOf('function'))
    session?.sendAudio(new ArrayBuffer(368000))
    session?.sendAudio(new ArrayBuffer(1))

    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: session?.sessionId,
      asrEngine: 'deepgram',
      asrModel: 'nova-3',
    }))
    releaseSend()
    await session?.close()
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')).toHaveLength(1)
  })

  it('places Finalize at its audio frontier, coalesces identical frontiers, and waits only for native write completion', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    const pending: Array<() => void> = []
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'deepgram_stream_send' || command === 'deepgram_stream_finalize') {
        return new Promise<void>((resolve) => { pending.push(resolve) })
      }
      return Promise.resolve(undefined)
    })
    const provider = new CloudAPIProvider()
    const session = await provider.openLive(
      { runId: 57 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )
    session?.sendAudio(new ArrayBuffer(16000))
    const finalize = session?.finalize()
    const repeatedFinalize = session?.finalize()
    session?.sendAudio(new ArrayBuffer(16000))
    expect(repeatedFinalize).toBe(finalize)

    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')).toHaveLength(1))
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'deepgram_stream_open',
      'deepgram_stream_send',
    ])
    pending.shift()?.()
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'deepgram_stream_open',
      'deepgram_stream_send',
      'deepgram_stream_finalize',
    ]))
    let closed = false
    const closing = session?.close().then(() => { closed = true })
    await Promise.resolve()
    expect(closed).toBe(false)
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_close')).toBe(false)
    let finalized = false
    void finalize?.then(() => { finalized = true })
    pending.shift()?.()
    await finalize
    expect(finalized).toBe(true)
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')).toHaveLength(2))
    pending.shift()?.()
    await closing
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_finalize')).toHaveLength(1)
    expect(mocks.invoke.mock.calls.find(([command]) => command === 'deepgram_stream_finalize')?.[1])
      .toEqual({ sessionId: session?.sessionId })
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_finish')).toBe(false)
  })

  it('cancels an opening epoch only after the captured tagged owner is closed', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    let completeOpen!: () => void
    mocks.invoke.mockImplementation((command: string) => command === 'deepgram_stream_open'
      ? new Promise<void>((resolve) => { completeOpen = resolve })
      : Promise.resolve(undefined))
    const provider = new CloudAPIProvider()
    const open = provider.openLive(
      { runId: 58 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )
    await vi.waitFor(() => expect(completeOpen).toBeTypeOf('function'))
    const openArgs = mocks.invoke.mock.calls.find(([command]) => command === 'deepgram_stream_open')?.[1] as { sessionId: string }
    let closed = false
    const close = provider.closeLive().then(() => { closed = true })
    await Promise.resolve()

    expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_close')).toBe(false)
    expect(closed).toBe(false)
    completeOpen()
    await expect(open).resolves.toBeNull()
    await close

    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toEqual([
      ['deepgram_stream_close', { sessionId: openArgs.sessionId }],
    ])
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_finish')).toBe(false)
  })

  it('rejects a native open that settles after its watchdog, after awaiting tagged cleanup', async () => {
    vi.useFakeTimers()
    try {
      mocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
        console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
      })
      let completeOpen!: () => void
      let completeClose!: () => void
      mocks.invoke.mockImplementation((command: string) => {
        if (command === 'deepgram_stream_open') {
          return new Promise<void>((resolve) => { completeOpen = resolve })
        }
        if (command === 'deepgram_stream_close') {
          return new Promise<void>((resolve) => { completeClose = resolve })
        }
        return Promise.resolve(undefined)
      })
      const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
      const provider = new CloudAPIProvider()
      let openingSettled = false
      const opening = provider.openLive({ runId: 65 }, callbacks).then(
        (session) => {
          openingSettled = true
          return { session }
        },
        (error: unknown) => {
          openingSettled = true
          return { error }
        },
      )
      for (let attempt = 0; attempt < 12 && !completeOpen; attempt++) await Promise.resolve()
      expect(completeOpen).toBeTypeOf('function')
      const openArgs = mocks.invoke.mock.calls.find(([command]) => command === 'deepgram_stream_open')?.[1] as { sessionId: string }

      await vi.advanceTimersByTimeAsync(10_001)
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: openArgs.sessionId,
        message: expect.stringMatching(/stalled/i),
      }))
      completeOpen()
      for (let attempt = 0; attempt < 12 && !completeClose; attempt++) await Promise.resolve()

      expect(completeClose).toBeTypeOf('function')
      expect(openingSettled).toBe(false)
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toEqual([
        ['deepgram_stream_close', { sessionId: openArgs.sessionId }],
      ])

      completeClose()
      const outcome = await opening
      expect(outcome).toHaveProperty('error')
      expect(outcome).not.toHaveProperty('session')
      expect(String((outcome as { error: unknown }).error)).toMatch(/stalled/i)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a tagged open error after settling and leaves failed tagged cleanup retryable', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    let completeOpen!: () => void
    let closeAttempts = 0
    mocks.invoke.mockImplementation((command: string) => {
      if (command === 'deepgram_stream_open') {
        return new Promise<void>((resolve) => { completeOpen = resolve })
      }
      if (command === 'deepgram_stream_close' && ++closeAttempts === 1) {
        return Promise.reject(new Error('captured owner close failed'))
      }
      return Promise.resolve(undefined)
    })
    const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const provider = new CloudAPIProvider()
    let returnedSession: Awaited<ReturnType<CloudAPIProvider['openLive']>> | undefined
    let openError: unknown
    const opening = provider.openLive({ runId: 66 }, callbacks).then(
      (session) => { returnedSession = session },
      (error: unknown) => { openError = error },
    )
    for (let attempt = 0; attempt < 12 && !completeOpen; attempt++) await Promise.resolve()
    expect(completeOpen).toBeTypeOf('function')
    const openArgs = mocks.invoke.mock.calls.find(([command]) => command === 'deepgram_stream_open')?.[1] as { sessionId: string }
    for (const listener of mocks.listeners.get('deepgram-live-error') ?? []) {
      listener({ payload: { sessionId: openArgs.sessionId, message: 'Deepgram closed the live stream unexpectedly' } })
    }
    completeOpen()
    await opening

    expect(returnedSession).toBeUndefined()
    expect(openError).toBeInstanceOf(Error)
    expect(String(openError)).toMatch(/Deepgram closed the live stream unexpectedly/)
    expect(String(openError)).toMatch(/captured owner close failed/)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toEqual([
      ['deepgram_stream_close', { sessionId: openArgs.sessionId }],
    ])
    await expect(provider.openLive(
      { runId: 67 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )).rejects.toThrow(/owner|cleanup|close/i)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_open')).toHaveLength(1)

    await provider.closeLive()
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toEqual([
      ['deepgram_stream_close', { sessionId: openArgs.sessionId }],
      ['deepgram_stream_close', { sessionId: openArgs.sessionId }],
    ])
  })

  it('keeps a failed live cleanup owner retryable and blocks replacement opens', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    let closeAttempts = 0
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deepgram_stream_close' && ++closeAttempts === 1) throw new Error('native owner still active')
      return undefined
    })
    const provider = new CloudAPIProvider()
    const first = await provider.openLive(
      { runId: 59 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )

    await expect(first?.close()).rejects.toThrow('native owner still active')
    expect(closeAttempts).toBe(1)
    await expect(provider.openLive(
      { runId: 60 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )).rejects.toThrow(/cleanup|close|owner/i)
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_open')).toHaveLength(1)

    await provider.closeLive()
    expect(closeAttempts).toBe(2)
    const replacement = await provider.openLive(
      { runId: 61 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )
    expect(replacement).not.toBeNull()
    expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_open')).toHaveLength(2)
    await replacement?.close()
  })

  it('releases the owner after a close-window watchdog when tagged native close succeeds', async () => {
    vi.useFakeTimers()
    try {
      mocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
        console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
      })
      let releaseSend!: () => void
      let releaseClose!: () => void
      let closeAttempts = 0
      mocks.invoke.mockImplementation((command: string) => {
        if (command === 'deepgram_stream_send') return new Promise<void>((resolve) => { releaseSend = resolve })
        if (command === 'deepgram_stream_close' && ++closeAttempts === 1) {
          return new Promise<void>((resolve) => { releaseClose = resolve })
        }
        return Promise.resolve(undefined)
      })
      const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
      const provider = new CloudAPIProvider()
      const session = await provider.openLive({ runId: 73 }, callbacks)
      session?.sendAudio(new ArrayBuffer(16000))
      for (let attempt = 0; attempt < 12 && !releaseSend; attempt++) await Promise.resolve()
      expect(releaseSend).toBeTypeOf('function')

      const closing = session?.close()
      await vi.advanceTimersByTimeAsync(5001)
      expect(callbacks.onError).not.toHaveBeenCalled()
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_close')).toBe(false)

      releaseSend()
      for (let attempt = 0; attempt < 12 && !releaseClose; attempt++) await Promise.resolve()
      expect(releaseClose).toBeTypeOf('function')
      await expect(provider.openLive(
        { runId: 74 },
        { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
      )).rejects.toThrow(/cleanup.*pending/i)

      releaseClose()
      await expect(closing).resolves.toBeUndefined()
      expect(callbacks.onError).not.toHaveBeenCalled()
      expect(mocks.addRuntimeEvent).toHaveBeenCalledWith(
        'warn',
        'cloud_api',
        expect.stringMatching(/live operation failed while closing/i),
        expect.objectContaining({
          sessionId: session?.sessionId,
          error: expect.stringMatching(/deepgram_stream_send operation stalled/i),
        }),
      )

      const replacement = await provider.openLive(
        { runId: 75 },
        { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
      )
      expect(replacement).not.toBeNull()
      await replacement?.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps all close callers pending until an in-flight native operation actually completes', async () => {
    vi.useFakeTimers()
    try {
      mocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
        console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
      })
      let releaseSend!: () => void
      mocks.invoke.mockImplementation((command: string) => command === 'deepgram_stream_send'
        ? new Promise<void>((resolve) => { releaseSend = resolve })
        : Promise.resolve(undefined))
      const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
      const provider = new CloudAPIProvider()
      const session = await provider.openLive({ runId: 76 }, callbacks)
      session?.sendAudio(new ArrayBuffer(16000))
      await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_send')).toBe(true))
      let completed = 0
      let closeError: unknown
      const closing = session?.close().then(() => { completed++ }, (error: unknown) => { closeError = error; completed++ })

      await vi.advanceTimersByTimeAsync(10_001)
      expect(completed).toBe(0)
      expect(closeError).toBeUndefined()
      expect(callbacks.onError).not.toHaveBeenCalled()
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_close')).toBe(false)

      const retry = provider.closeLive().then(() => { completed++ })
      await vi.advanceTimersByTimeAsync(10_001)
      expect(completed).toBe(0)
      await expect(provider.openLive(
        { runId: 77 },
        { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
      )).rejects.toThrow(/cleanup.*pending/i)
      releaseSend()
      await Promise.all([closing, retry])
      expect(completed).toBe(2)
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps failed-open cleanup reachable through closeLive and never invokes an untagged close', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    let closeAttempts = 0
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deepgram_stream_open') throw new Error('handshake failed')
      if (command === 'deepgram_stream_close' && ++closeAttempts === 1) throw new Error('close timed out')
      return undefined
    })
    const provider = new CloudAPIProvider()

    await expect(provider.openLive(
      { runId: 62 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )).rejects.toThrow(/handshake failed|close timed out/)
    await provider.closeLive()

    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual([
      'deepgram_stream_open',
      'deepgram_stream_close',
      'deepgram_stream_close',
    ])
    expect(mocks.invoke.mock.calls.slice(1).every(([, args]) => (
      typeof (args as { sessionId?: unknown }).sessionId === 'string'
    ))).toBe(true)
  })

  it('reports a stalled send as terminal without releasing its in-flight owner or budget', async () => {
    vi.useFakeTimers()
    try {
      mocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
        console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
      })
      let releaseSend!: () => void
      mocks.invoke.mockImplementation((command: string) => command === 'deepgram_stream_send'
        ? new Promise<void>((resolve) => { releaseSend = resolve })
        : Promise.resolve(undefined))
      const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
      const provider = new CloudAPIProvider()
      const session = await provider.openLive({ runId: 63 }, callbacks)
      session?.sendAudio(new ArrayBuffer(16000))
      for (let attempt = 0; attempt < 12 && !releaseSend; attempt++) await Promise.resolve()
      expect(releaseSend).toBeTypeOf('function')
      await vi.advanceTimersByTimeAsync(5001)

      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: session?.sessionId,
        message: expect.stringMatching(/stalled|timeout/i),
      }))
      let closed = false
      const close = session?.close().then(() => { closed = true })
      await Promise.resolve()
      expect(closed).toBe(false)
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_close')).toBe(false)

      releaseSend()
      await close
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_send')).toHaveLength(1)
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects a stalled finalize but waits for native completion before confirming close', async () => {
    vi.useFakeTimers()
    try {
      mocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
        console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
      })
      let releaseFinalize!: () => void
      mocks.invoke.mockImplementation((command: string) => command === 'deepgram_stream_finalize'
        ? new Promise<void>((resolve) => { releaseFinalize = resolve })
        : Promise.resolve(undefined))
      const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
      const provider = new CloudAPIProvider()
      const session = await provider.openLive({ runId: 68 }, callbacks)
      const finalize = session?.finalize()
      let finalizeSettled = false
      let finalizeError: unknown
      void finalize?.then(
        () => { finalizeSettled = true },
        (error: unknown) => { finalizeSettled = true; finalizeError = error },
      )
      for (let attempt = 0; attempt < 12 && !releaseFinalize; attempt++) await Promise.resolve()
      expect(releaseFinalize).toBeTypeOf('function')

      await vi.advanceTimersByTimeAsync(5001)
      expect(finalizeSettled).toBe(true)
      expect(finalizeError).toBeInstanceOf(Error)
      expect(String(finalizeError)).toMatch(/stalled/i)
      expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        sessionId: session?.sessionId,
        message: expect.stringMatching(/stalled/i),
      }))

      let closeSettled = false
      const close = session?.close().then(() => { closeSettled = true })
      await vi.advanceTimersByTimeAsync(10_001)
      expect(closeSettled).toBe(false)
      expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_close')).toBe(false)
      expect(mocks.listeners.get('deepgram-live-result')?.size).toBe(1)
      expect(mocks.listeners.get('deepgram-live-error')?.size).toBe(1)

      releaseFinalize()
      await close
      expect(closeSettled).toBe(true)
      expect(mocks.listeners.get('deepgram-live-result')?.size).toBe(0)
      expect(mocks.listeners.get('deepgram-live-error')?.size).toBe(0)
      for (let attempt = 0; attempt < 12 && !mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_close'); attempt++) {
        await Promise.resolve()
      }
      expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toEqual([
        ['deepgram_stream_close', { sessionId: session?.sessionId }],
      ])
      expect(callbacks.onError).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('disconnects a live owner and allows opening again after deferred cleanup completes', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    let releaseSend!: () => void
    mocks.invoke.mockImplementation((command: string) => command === 'deepgram_stream_send'
      ? new Promise<void>((resolve) => { releaseSend = resolve })
      : Promise.resolve(undefined))
    const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const provider = new CloudAPIProvider()
    const session = await provider.openLive({ runId: 69 }, callbacks)
    session?.sendAudio(new ArrayBuffer(16000))
    await vi.waitFor(() => expect(releaseSend).toBeTypeOf('function'))

    provider.disconnect()
    await expect(provider.openLive(
      { runId: 70 },
      { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
    )).rejects.toThrow(/cleanup.*native operation settles/i)
    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      sessionId: session?.sessionId,
      message: expect.stringMatching(/disconnect|cancel/i),
    }))

    releaseSend()
    await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === 'deepgram_stream_close')).toEqual([
      ['deepgram_stream_close', { sessionId: session?.sessionId }],
    ]))
    const replacement = await vi.waitFor(async () => {
      const opened = await provider.openLive(
        { runId: 71 },
        { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
      )
      if (!opened) throw new Error('Live ASR replacement did not open')
      return opened
    })
    await replacement.close()
    expect(mocks.listeners.get('deepgram-live-result')?.size).toBe(0)
    expect(mocks.listeners.get('deepgram-live-error')?.size).toBe(0)
  })

  it('does not retry a timed-out native close after its late success', async () => {
    vi.useFakeTimers()
    try {
      mocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
        console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
      })
      let releaseClose!: () => void
      let closeAttempts = 0
      let originalSessionId = ''
      mocks.invoke.mockImplementation((command: string, args: unknown) => {
        if (command === 'deepgram_stream_close') {
          const closeArgs = args as { sessionId: string }
          if (closeArgs.sessionId === originalSessionId) {
            closeAttempts++
            if (closeAttempts === 1) return new Promise<void>((resolve) => { releaseClose = resolve })
            throw new Error('duplicate tagged close after prior completion')
          }
        }
        return Promise.resolve(undefined)
      })
      const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
      const provider = new CloudAPIProvider()
      const session = await provider.openLive({ runId: 72 }, callbacks)
      originalSessionId = session?.sessionId ?? ''
      let closeError: unknown
      let closeSettled = false
      const close = session?.close().then(
        () => { closeSettled = true },
        (error: unknown) => { closeSettled = true; closeError = error },
      )
      for (let attempt = 0; attempt < 12 && !releaseClose; attempt++) await Promise.resolve()
      expect(releaseClose).toBeTypeOf('function')

      await vi.advanceTimersByTimeAsync(5001)
      expect(closeSettled).toBe(false)
      expect(closeError).toBeUndefined()
      expect(callbacks.onError).not.toHaveBeenCalled()

      const retry = provider.closeLive()
      releaseClose()
      await expect(close).resolves.toBeUndefined()
      await expect(retry).resolves.toBeUndefined()
      const replacement = await provider.openLive(
        { runId: 78 },
        { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() },
      )
      expect(replacement).not.toBeNull()
      expect(closeAttempts).toBe(1)
      await replacement?.close()
    } finally {
      vi.useRealTimers()
    }
  })

  it('treats a matching native stream error as terminal and preserves its provider metadata', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    const callbacks = { onResult: vi.fn(), onError: vi.fn(), onWarning: vi.fn() }
    const provider = new CloudAPIProvider()
    const session = await provider.openLive({ runId: 64 }, callbacks)
    for (const listener of mocks.listeners.get('deepgram-live-error') ?? []) {
      listener({ payload: { sessionId: session?.sessionId, message: 'Deepgram reader failed' } })
    }

    expect(callbacks.onError).toHaveBeenCalledExactlyOnceWith({
      sessionId: session?.sessionId,
      message: 'Deepgram reader failed',
      asrEngine: 'deepgram',
      asrModel: 'nova-3',
    })
    session?.sendAudio(new ArrayBuffer(16000))
    await session?.close()
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'deepgram_stream_send')).toBe(false)
    expect(mocks.invoke.mock.calls.some(([command]) => command === 'cloud_transcribe')).toBe(false)
  })

  it('does not leave an unhandled rejection when the live error callback throws an unstringifiable value', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-profile', provider: 'deepgram', apiKey: 'key', appId: '',
      console: 'new', otherKey: '', workspaceId: '', model: 'nova-3', omniPrompt: '',
    })
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === 'deepgram_stream_send') throw new Error('socket is gone')
      return undefined
    })
    const onError = vi.fn(() => { throw Object.create(null) })
    const provider = new CloudAPIProvider()
    const session = await provider.openLive(
      { runId: 79 },
      { onResult: vi.fn(), onError, onWarning: vi.fn() },
    )
    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
    const processEvents = Reflect.get(globalThis, 'process') as {
      on: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
      off: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
    }
    processEvents.on('unhandledRejection', onUnhandledRejection)
    try {
      session?.sendAudio(new ArrayBuffer(16000))
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(unhandledRejections).toEqual([])
      expect(onError).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: session?.sessionId }))
      expect(mocks.addRuntimeEvent).toHaveBeenCalledWith(
        'error',
        'cloud_api',
        expect.stringMatching(/drain/i),
        expect.objectContaining({ sessionId: session?.sessionId }),
      )
    } finally {
      processEvents.off('unhandledRejection', onUnhandledRejection)
      await provider.closeLive()
    }
  })

  it('runs a selected-text edit through the chosen service even when the ASR provider is Qwen Omni', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'omni', provider: 'qwen_omni_38_realtime', model: 'qwen3-omni-flash-realtime', apiKey: 'key', omniPrompt: '',
    })
    mocks.polishWithClientAi.mockResolvedValue({
      llmText: 'Edited by the chosen service', llmMs: 30, contextApplied: true,
      aiSource: 'custom', aiStatus: 'applied', aiModel: 'gpt-edit',
    })
    const provider = new CloudAPIProvider()
    const onFinal = vi.fn()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    await provider.connect({ onFinal, onDone: finish })

    const selectionAiConfig = {
      provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-edit', model: 'gpt-edit',
      reasoningEffort: 'high', serviceTier: 'priority',
    }
    provider.start({
      runId: 30,
      disableStreaming: true,
      selectionAiConfig,
      textContext: { source: 'uia', textBefore: '', selectedText: 'Original', textAfter: '', selectionTruncated: false },
      systemPrompt: 'Edit selected text',
    })
    provider.sendAudio(new ArrayBuffer(16000))
    provider.stop()
    await done

    expect(mocks.polishWithClientAi).toHaveBeenCalledTimes(1)
    const call = mocks.polishWithClientAi.mock.calls[0][0] as { startOptions: { selectionAiConfig: unknown } }
    expect(call.startOptions.selectionAiConfig).toEqual(selectionAiConfig)
    // ASR attribution stays Omni; AI attribution must describe the chosen service.
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      llmText: 'Edited by the chosen service',
      asrText: 'recognized',
      asrEngine: 'qwen_omni',
      aiSource: 'custom',
      aiModel: 'gpt-edit',
    }))
  })

  it('keeps the built-in Omni skip and preserves the selection when no service is chosen', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'omni', provider: 'qwen_omni_38_realtime', model: 'qwen3-omni-flash-realtime', apiKey: 'key', omniPrompt: '',
    })
    const provider = new CloudAPIProvider()
    const onFinal = vi.fn()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    await provider.connect({ onFinal, onDone: finish })

    provider.start({
      runId: 31,
      disableStreaming: true,
      textContext: { source: 'uia', textBefore: '', selectedText: 'Original', textAfter: '', selectionTruncated: false },
    })
    provider.sendAudio(new ArrayBuffer(16000))
    provider.stop()
    await done

    expect(mocks.polishWithClientAi).not.toHaveBeenCalled()
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      llmText: 'Original',
      aiStatus: 'skipped',
    }))
  })

  it('sends a translated Omni run through the client AI stage instead of the built-in cleanup', async () => {
    mocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'omni', provider: 'qwen_omni_38_realtime', model: 'qwen3-omni-flash-realtime', apiKey: 'key', omniPrompt: '',
    })
    mocks.polishWithClientAi.mockResolvedValue({
      llmText: 'Translated speech', llmMs: 25, aiSource: 'custom', aiStatus: 'applied', aiModel: 'gpt-translate',
    })
    const provider = new CloudAPIProvider()
    const onFinal = vi.fn()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    await provider.connect({ onFinal, onDone: finish })

    provider.start({
      runId: 32,
      disableStreaming: true,
      requireTranslation: true,
      systemPrompt: 'Translate into Russian',
    })
    provider.sendAudio(new ArrayBuffer(16000))
    provider.stop()
    await done

    expect(mocks.polishWithClientAi).toHaveBeenCalledTimes(1)
    const call = mocks.polishWithClientAi.mock.calls[0][0] as { asrText: string; startOptions: { requireTranslation?: boolean } }
    expect(call.asrText).toBe('recognized')
    expect(call.startOptions.requireTranslation).toBe(true)
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({
      asrText: 'recognized',
      llmText: 'Translated speech',
      asrEngine: 'qwen_omni',
      aiSource: 'custom',
      aiStatus: 'applied',
    }))
  })
})

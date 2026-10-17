import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptionCallbacks, FinalResult, StartOptions } from '../types'

type ServerAiSource = 'managed' | 'custom'

const mocks = vi.hoisted(() => ({
  runtimeSource: 'managed' as ServerAiSource,
  storedSource: 'managed' as ServerAiSource,
  getSetting: vi.fn(),
  connect: vi.fn(),
  sendStart: vi.fn(),
  sendStop: vi.fn(),
  sendAudio: vi.fn(),
  disconnect: vi.fn(),
  supportsTextContext: vi.fn(() => false),
  polishWithClientAi: vi.fn(),
}))

vi.mock('../../store', () => ({
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
}))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
vi.mock('../../websocket', () => ({
  connect: (...args: unknown[]) => mocks.connect(...args),
  sendStart: (...args: unknown[]) => mocks.sendStart(...args),
  sendStop: (...args: unknown[]) => mocks.sendStop(...args),
  sendAudio: (...args: unknown[]) => mocks.sendAudio(...args),
  disconnect: (...args: unknown[]) => mocks.disconnect(...args),
  isConnected: () => true,
  supportsTextContext: () => mocks.supportsTextContext(),
}))
vi.mock('../serverAiSource', () => ({
  getRuntimeServerAiSource: () => mocks.runtimeSource,
  loadServerAiSource: async () => mocks.getSetting('server.aiSource', 'managed'),
}))
vi.mock('../clientAiPolish', () => ({
  polishWithClientAi: (...args: unknown[]) => mocks.polishWithClientAi(...args),
}))

import { ServerProvider } from '../ServerProvider'

const serverResult: FinalResult = {
  asrText: 'Recognized speech',
  llmText: 'Server result',
  asrMs: 10,
  llmMs: 5,
  durationSec: 1,
}

const startOptions: StartOptions = { runId: 1 }

let wireCallbacks: TranscriptionCallbacks | undefined

async function flushPromises() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('ServerProvider AI route snapshots', () => {
  beforeEach(() => {
    mocks.runtimeSource = 'managed'
    mocks.storedSource = 'managed'
    mocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'server.aiSource') return mocks.storedSource
      if (key === 'cloudAi.provider') return 'ollama'
      if (key === 'cloudAi.apiUrl') return 'http://127.0.0.1:11434'
      if (key === 'cloudAi.apiKey') return ''
      if (key === 'cloudAi.model') return 'fixture-model'
      return fallback
    })
    mocks.connect.mockReset().mockImplementation(async (callbacks: TranscriptionCallbacks) => {
      wireCallbacks = callbacks
    })
    mocks.sendStart.mockReset().mockReturnValue(true)
    mocks.sendStop.mockReset().mockReturnValue(true)
    mocks.sendAudio.mockReset()
    mocks.disconnect.mockReset()
    mocks.supportsTextContext.mockReset().mockReturnValue(false)
    mocks.polishWithClientAi.mockReset()
    wireCallbacks = undefined
  })

  it('keeps the captured custom route after the runtime source flips before final delivery', async () => {
    mocks.runtimeSource = 'custom'
    const polished = {
      llmText: 'Client result',
      llmMs: 20,
      aiSource: 'custom' as const,
      aiStatus: 'applied' as const,
    }
    let resolvePolish!: (value: typeof polished) => void
    mocks.polishWithClientAi.mockImplementation(() => new Promise((resolve) => { resolvePolish = resolve }))

    const callbacks = {
      onFinal: vi.fn(),
      onDone: vi.fn(),
    }
    const provider = new ServerProvider()
    await provider.connect(callbacks)

    expect(provider.start(startOptions)).toBe(true)
    expect(mocks.sendStart).toHaveBeenCalledWith(expect.objectContaining({ disableAi: true }))
    expect(provider.stop()).toBe(true)
    expect(mocks.sendStop).toHaveBeenCalledWith(expect.objectContaining({ disableAi: true }))

    mocks.runtimeSource = 'managed'
    wireCallbacks?.onFinal?.(serverResult)
    wireCallbacks?.onDone?.()

    expect(mocks.polishWithClientAi).toHaveBeenCalledTimes(1)
    expect(callbacks.onDone).not.toHaveBeenCalled()

    resolvePolish(polished)
    await flushPromises()

    expect(callbacks.onFinal).toHaveBeenCalledWith(expect.objectContaining({
      llmText: 'Client result',
      aiSource: 'custom',
    }))
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
  })

  it('reads the runtime source live when deciding text-context support', () => {
    const provider = new ServerProvider()
    mocks.runtimeSource = 'custom'
    expect(provider.acceptsTextContext()).toBe(true)

    mocks.runtimeSource = 'managed'
    expect(provider.acceptsTextContext()).toBe(false)
  })

  it.each([
    { storedSource: 'custom' as const, runtimeSource: 'managed' as const, serverLlm: false, expectedLlm: true },
    { storedSource: 'managed' as const, runtimeSource: 'custom' as const, serverLlm: false, expectedLlm: false },
    { storedSource: 'managed' as const, runtimeSource: 'custom' as const, serverLlm: true, expectedLlm: true },
  ])('maps connect-time readiness for stored $storedSource AI', async ({ storedSource, runtimeSource, serverLlm, expectedLlm }) => {
    mocks.storedSource = storedSource
    mocks.runtimeSource = runtimeSource
    const onReady = vi.fn()
    const provider = new ServerProvider()

    await provider.connect({ onReady })
    expect(wireCallbacks?.onReady).toBeDefined()
    wireCallbacks?.onReady?.({ connectionId: 'connection-1', asr: true, llm: serverLlm })

    expect(onReady).toHaveBeenCalledWith({ connectionId: 'connection-1', asr: true, llm: expectedLlm })
  })

  it('keeps reporting managed readiness on reconnect after a selection-edit run', async () => {
    // An incomplete custom profile makes a leaked per-run client route visible as llm=false.
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'server.aiSource') return mocks.storedSource
      if (key === 'cloudAi.provider') return 'openai'
      if (key === 'cloudAi.apiUrl') return 'https://api.openai.com/v1'
      if (key === 'cloudAi.apiKey') return ''
      if (key === 'cloudAi.model') return ''
      return fallback
    })
    mocks.polishWithClientAi.mockResolvedValue({
      llmText: 'Edited',
      llmMs: 20,
      aiSource: 'custom',
      aiStatus: 'applied',
    })
    const onReady = vi.fn()
    const onDone = vi.fn()
    const provider = new ServerProvider()
    await provider.connect({ onReady, onFinal: vi.fn(), onDone })

    expect(provider.start({
      runId: 1,
      selectionAiConfig: {
        provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-edit', model: 'gpt-edit',
        reasoningEffort: '', serviceTier: '',
      },
    })).toBe(true)
    expect(provider.stop()).toBe(true)
    wireCallbacks?.onFinal?.(serverResult)
    wireCallbacks?.onDone?.()
    await flushPromises()
    expect(mocks.polishWithClientAi).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledTimes(1)

    // The websocket module re-fires onReady with the same callbacks after an automatic reconnect.
    wireCallbacks?.onReady?.({ connectionId: 'connection-2', asr: true, llm: true })

    expect(onReady).toHaveBeenLastCalledWith({ connectionId: 'connection-2', asr: true, llm: true })
  })

  it('reports custom readiness for keyless Ollama with a blank model, since the native layer substitutes its default', async () => {
    mocks.storedSource = 'custom'
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'server.aiSource') return mocks.storedSource
      if (key === 'cloudAi.provider') return 'ollama'
      if (key === 'cloudAi.apiUrl') return 'http://127.0.0.1:11434'
      if (key === 'cloudAi.apiKey') return ''
      if (key === 'cloudAi.model') return ''
      return fallback
    })
    const onReady = vi.fn()
    const provider = new ServerProvider()

    await provider.connect({ onReady })
    wireCallbacks?.onReady?.({ connectionId: 'connection-1', asr: true, llm: false })

    expect(onReady).toHaveBeenCalledWith({ connectionId: 'connection-1', asr: true, llm: true })
  })

  it('keeps custom readiness false for a keyed provider with a blank model', async () => {
    mocks.storedSource = 'custom'
    mocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => {
      if (key === 'server.aiSource') return mocks.storedSource
      if (key === 'cloudAi.provider') return 'openai_compat'
      if (key === 'cloudAi.apiUrl') return 'https://api.openai.com'
      if (key === 'cloudAi.apiKey') return 'sk-key'
      if (key === 'cloudAi.model') return ''
      return fallback
    })
    const onReady = vi.fn()
    const provider = new ServerProvider()

    await provider.connect({ onReady })
    wireCallbacks?.onReady?.({ connectionId: 'connection-1', asr: true, llm: false })

    expect(onReady).toHaveBeenCalledWith({ connectionId: 'connection-1', asr: true, llm: false })
  })
})

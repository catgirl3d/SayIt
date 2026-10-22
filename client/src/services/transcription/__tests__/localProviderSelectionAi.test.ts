import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.fn()
const getSettingMock = vi.fn()
const runtimeEvents = vi.hoisted(() => ({ addRuntimeEvent: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }))
vi.mock('../../store', () => ({ getSetting: (...args: unknown[]) => getSettingMock(...args) }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent: (...args: unknown[]) => runtimeEvents.addRuntimeEvent(...args) }))

import { LocalProvider } from '../LocalProvider'

describe('LocalProvider selection-edit service', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    getSettingMock.mockReset()
    getSettingMock.mockImplementation((key: string, fallback: unknown) =>
      Promise.resolve(key === 'localAsr.modelId' ? 'sensevoice-small-gguf' : fallback))
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_downloaded_models') return Promise.resolve([{ id: 'sensevoice-small-gguf', complete: true }])
      if (cmd === 'local_transcribe') return Promise.resolve({ text: 'make this shorter', elapsed_ms: 12 })
      if (cmd === 'cloud_polish') return Promise.resolve({ text: 'Shorter text', elapsed_ms: 20 })
      return Promise.resolve('')
    })
  })

  it('sends the frozen selection-edit service with the polish request', async () => {
    const provider = new LocalProvider()
    await provider.connect({})
    provider.start({
      runId: 5,
      selectionAiConfig: {
        provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-edit', model: 'gpt-edit',
        reasoningEffort: 'high', serviceTier: 'priority',
      },
      systemPrompt: 'Edit selected text',
      textContext: { source: 'uia', textBefore: '', selectedText: 'Original', textAfter: '', selectionTruncated: false },
    })
    provider.sendAudio(new ArrayBuffer(32_000))
    provider.stop()

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('cloud_polish', {
      request: expect.objectContaining({
        text: 'make this shorter',
        ai_config: expect.objectContaining({
          model: 'gpt-edit',
          extra: { reasoning_effort: 'high', service_tier: 'priority' },
        }),
      }),
    }))
  })
})

describe('LocalProvider empty recognition', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    getSettingMock.mockReset()
    runtimeEvents.addRuntimeEvent.mockReset()
    getSettingMock.mockImplementation((key: string, fallback: unknown) =>
      Promise.resolve(key === 'localAsr.modelId' ? 'sensevoice-small-gguf' : fallback))
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === 'list_downloaded_models') return Promise.resolve([{ id: 'sensevoice-small-gguf', complete: true }])
      if (cmd === 'local_transcribe') return Promise.resolve({ text: '  ', elapsed_ms: 12 })
      return Promise.resolve('')
    })
  })

  it('stamps the skipped AI metadata on the ASR result and the final, and writes one outcome record', async () => {
    const provider = new LocalProvider()
    const onASR = vi.fn()
    const onFinal = vi.fn()
    let finish!: () => void
    const done = new Promise<void>((resolve) => { finish = resolve })
    await provider.connect({ onASR, onFinal, onDone: finish })

    provider.start({ runId: 6 })
    provider.sendAudio(new ArrayBuffer(32_000))
    provider.stop()
    await done

    // The recorder persists the empty record from the ASR result, so it must carry the execution metadata.
    expect(onASR).toHaveBeenCalledWith(expect.objectContaining({ aiSource: 'none', aiStatus: 'skipped' }))
    expect(onFinal).toHaveBeenCalledWith(expect.objectContaining({ aiSource: 'none', aiStatus: 'skipped' }))
    expect(invokeMock).not.toHaveBeenCalledWith('cloud_polish', expect.anything())
    const outcomes = runtimeEvents.addRuntimeEvent.mock.calls.filter(([, , message]) => message === 'ai.outcome')
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject(['info', 'local', 'ai.outcome', {
      source: 'none', status: 'skipped', attempted: false, skipCause: 'empty_asr',
    }])
  })
})

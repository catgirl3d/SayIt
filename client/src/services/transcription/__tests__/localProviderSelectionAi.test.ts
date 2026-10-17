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

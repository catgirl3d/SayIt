import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  connect: vi.fn(),
  polishWithClientAi: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('../../websocket', () => ({
  connect: (...args: unknown[]) => mocks.connect(...args),
  sendStart: (...args: unknown[]) => mocks.start(...args),
  sendStop: (...args: unknown[]) => mocks.stop(...args),
  sendAudio: vi.fn(),
  disconnect: vi.fn(),
  isConnected: () => true,
  supportsTextContext: () => true,
}))
vi.mock('../serverAiSource', () => ({
  getRuntimeServerAiSource: () => 'managed',
  loadServerAiSource: async () => 'managed',
}))
vi.mock('../clientAiPolish', () => ({
  polishWithClientAi: (...args: unknown[]) => mocks.polishWithClientAi(...args),
}))

import { ServerProvider } from '../ServerProvider'
import type { StartOptions } from '../types'

const snapshot = {
  provider: 'openai', apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-edit', model: 'gpt-edit',
  reasoningEffort: 'high', serviceTier: 'priority',
}

const editorContext = {
  source: 'uia', textBefore: 'prefix', selectedText: 'Original', textAfter: 'suffix', selectionTruncated: false,
}

const options: StartOptions = {
  runId: 1,
  selectionAiConfig: snapshot,
  textContext: editorContext,
  // The captured editor text also rides inside appContext; the custom wire branch must strip it.
  appContext: { processName: 'Code.exe', windowTitle: 'SayIt.ts - Code', windowClass: 'Editor', textContext: editorContext } as StartOptions['appContext'],
  systemPrompt: 'Edit selected text',
}

const serverResult = { asrText: 'Shorten this', llmText: 'Shorten this', asrMs: 10, llmMs: 0, durationSec: 4 }

async function setup(startOptions: StartOptions) {
  const provider = new ServerProvider()
  const callbacks = { onFinal: vi.fn(), onDone: vi.fn() }
  await provider.connect(callbacks)
  provider.start(startOptions)
  provider.stop()
  return { provider, callbacks, wire: mocks.connect.mock.calls[0][0] as { onFinal?: (r: unknown) => void; onDone?: () => void } }
}

describe('server mode with a frozen selection-edit service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.start.mockReturnValue(true)
    mocks.stop.mockReturnValue(true)
    mocks.connect.mockImplementation(async () => undefined)
    mocks.polishWithClientAi.mockResolvedValue({
      llmText: 'Edited', llmMs: 20, contextApplied: true, aiSource: 'custom', aiStatus: 'applied', aiModel: 'gpt-edit',
    })
  })

  it('keeps the server on ASR and never sends the snapshot, its key, or editor text over the wire', async () => {
    await setup(options)
    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      disableAi: true,
      systemPrompt: undefined,
      textContext: undefined,
      selectionAiConfig: undefined,
    }))
    const wire = mocks.start.mock.calls[0][0] as { appContext?: { textContext?: unknown } }
    expect(wire.appContext?.textContext).toBeUndefined()
    expect(JSON.stringify(mocks.start.mock.calls)).not.toContain('sk-edit')
    expect(JSON.stringify(mocks.start.mock.calls)).not.toContain('Original')
    expect(mocks.stop).toHaveBeenCalledWith(expect.objectContaining({ disableAi: true }))
  })

  it('completes only after the chosen client service answers', async () => {
    let finish!: (value: unknown) => void
    mocks.polishWithClientAi.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const { callbacks, wire } = await setup(options)

    wire.onFinal?.(serverResult)
    wire.onDone?.()
    expect(callbacks.onDone).not.toHaveBeenCalled()

    finish({ llmText: 'Edited', llmMs: 20, contextApplied: true, aiSource: 'custom', aiStatus: 'applied', aiModel: 'gpt-edit' })
    await vi.waitFor(() => expect(callbacks.onFinal).toHaveBeenCalledWith(expect.objectContaining({
      llmText: 'Edited',
      aiSource: 'custom',
      aiModel: 'gpt-edit',
    })))
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(mocks.polishWithClientAi).toHaveBeenCalledWith(expect.objectContaining({
      startOptions: expect.objectContaining({ selectionAiConfig: snapshot }),
    }))
  })

  it('preserves the managed server path when no service is chosen', async () => {
    const normal: StartOptions = { ...options, selectionAiConfig: null }
    const { callbacks, wire } = await setup(normal)

    expect(mocks.start).toHaveBeenCalledWith(expect.objectContaining({
      textContext: options.textContext,
      systemPrompt: options.systemPrompt,
    }))
    wire.onFinal?.({ ...serverResult, llmText: 'Server edit', llmMs: 20, contextApplied: true })
    wire.onDone?.()
    expect(callbacks.onFinal).toHaveBeenCalledWith(expect.objectContaining({ llmText: 'Server edit', aiSource: 'server' }))
    expect(callbacks.onDone).toHaveBeenCalledTimes(1)
    expect(mocks.polishWithClientAi).not.toHaveBeenCalled()
  })

  it('discards late editor output after cancellation', async () => {
    let finish!: (value: unknown) => void
    mocks.polishWithClientAi.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const { provider, callbacks, wire } = await setup(options)

    wire.onFinal?.(serverResult)
    provider.cancel()
    finish({ llmText: 'Late', llmMs: 20, contextApplied: true, aiSource: 'custom', aiStatus: 'applied', aiModel: 'gpt-edit' })
    // A late server done for the same canceled run must be dropped too.
    wire.onDone?.()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(callbacks.onFinal).not.toHaveBeenCalled()
    expect(callbacks.onDone).not.toHaveBeenCalled()
  })

  it('does not leak the override into the next run on the same provider', async () => {
    const { provider, callbacks, wire } = await setup(options)
    wire.onFinal?.(serverResult)
    wire.onDone?.()
    await vi.waitFor(() => expect(callbacks.onDone).toHaveBeenCalledTimes(1))

    provider.start({ ...options, runId: 2, selectionAiConfig: null })
    provider.stop()

    const secondWire = mocks.start.mock.calls[1][0] as Record<string, unknown>
    expect(secondWire.textContext).toBe(editorContext)
    expect(secondWire.systemPrompt).toBe('Edit selected text')
    expect(secondWire.selectionAiConfig).toBeUndefined()
    expect(mocks.polishWithClientAi).toHaveBeenCalledTimes(1)
  })
})

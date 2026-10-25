// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = vi.hoisted(() => ({
  provider: {
    mode: 'server' as const,
    isReady: vi.fn(() => false),
    connect: vi.fn(),
    disconnect: vi.fn(),
    start: vi.fn(() => true),
    cancel: vi.fn(),
    sendAudio: vi.fn(),
  },
  runtimeEvents: vi.fn(),
}))

vi.mock('@/services/transcription', () => ({ getProvider: () => harness.provider }))
vi.mock('@/services/debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => harness.runtimeEvents(...args),
}))

import { ServerNotConfiguredError } from '@/services/runtimeConfig'
import { RecorderOrchestrator } from '../RecorderOrchestrator'

describe('recorder preconnection retry policy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    harness.provider.connect.mockReset()
    harness.provider.disconnect.mockReset()
    harness.provider.isReady.mockReset().mockReturnValue(false)
    harness.runtimeEvents.mockReset()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('does not schedule another connection when no server address is configured', async () => {
    harness.provider.connect.mockRejectedValue(new ServerNotConfiguredError())
    const recorder = new RecorderOrchestrator()

    recorder.reconnectProvider()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.provider.connect).toHaveBeenCalledTimes(1)
    expect(harness.runtimeEvents).toHaveBeenCalledWith(
      'warn',
      'websocket',
      'No server address is configured; not reconnecting',
    )

    await vi.advanceTimersByTimeAsync(5000)
    expect(harness.provider.connect).toHaveBeenCalledTimes(1)
  })

  it('connects again when a later reconnect is requested after an address is configured', async () => {
    harness.provider.connect
      .mockRejectedValueOnce(new ServerNotConfiguredError())
      .mockResolvedValueOnce(undefined)
    const recorder = new RecorderOrchestrator()

    recorder.reconnectProvider()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.provider.connect).toHaveBeenCalledTimes(1)

    recorder.reconnectProvider()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.provider.connect).toHaveBeenCalledTimes(2)
  })

  it('keeps retrying other connection failures after five seconds', async () => {
    harness.provider.connect.mockRejectedValue(new Error('server unreachable'))
    const recorder = new RecorderOrchestrator()

    recorder.reconnectProvider()
    await vi.advanceTimersByTimeAsync(0)

    expect(harness.provider.connect).toHaveBeenCalledTimes(1)
    expect(harness.runtimeEvents).toHaveBeenCalledWith(
      'warn',
      'websocket',
      'Preconnection failed; retrying in 5s',
      { error: 'Error: server unreachable' },
    )

    await vi.advanceTimersByTimeAsync(5000)
    expect(harness.provider.connect).toHaveBeenCalledTimes(2)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connect, disconnect } from '../websocket'
import { WebSocketConnectError } from '../runtimeConfig'

vi.mock('../runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtimeConfig')>()
  return { ...actual, getWSUrl: () => 'ws://test' }
})
vi.mock('../../stores/connectionStatus', () => ({ setConnectionStatus: vi.fn() }))
vi.mock('../debugLog', () => ({
  addMsg: vi.fn(), addAudioChunk: vi.fn(), startSession: vi.fn(), endSession: vi.fn(),
  addRuntimeEvent: vi.fn(), hasActiveSession: () => false,
}))

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  binaryType = ''
  url: string
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: { type: string }) => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  constructor(url: string) {
    this.url = url
    FakeWebSocket.instances.push(this)
  }

  send() {}

  /** Like a browser, a client-side close is reported asynchronously, after close() returns. */
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return
    this.readyState = FakeWebSocket.CLOSING
    queueMicrotask(() => this.emitClose(1000))
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  fail() {
    this.onerror?.({ type: 'error' })
    this.emitClose(1006)
  }

  /** Delivers only a close event, as a server-side drop or a refused connection does. */
  emitClose(code: number) {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ code, reason: '' })
  }
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]
  if (!socket) throw new Error('no WebSocket was created')
  return socket
}

describe('websocket connect() settles when the socket never opens', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    disconnect()
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('rejects when the socket fails before it opens', async () => {
    const pending = connect({})
    latestSocket().fail()
    await expect(pending).rejects.toBeInstanceOf(WebSocketConnectError)
  })

  it('rejects when the socket closes before it opens', async () => {
    const pending = connect({})
    latestSocket().emitClose(1006)
    await expect(pending).rejects.toBeInstanceOf(WebSocketConnectError)
  })

  it('rejects a pending connect that a newer connect replaces', async () => {
    const first = connect({})
    const second = connect({})
    await expect(first).rejects.toBeInstanceOf(WebSocketConnectError)

    latestSocket().open()
    await expect(second).resolves.toBeUndefined()
  })

  it('a new connect cancels a pending automatic reconnect', async () => {
    const first = connect({})
    latestSocket().open()
    await first

    // A drop after open schedules the automatic reconnect.
    latestSocket().emitClose(1006)

    const second = connect({})
    latestSocket().open()
    await second

    await vi.advanceTimersByTimeAsync(5_000)
    expect(FakeWebSocket.instances).toHaveLength(2)
  })

  it('a failed automatic reconnect leaves no unhandled rejection', async () => {
    const unhandled = vi.fn()
    const processEvents = Reflect.get(globalThis, 'process') as {
      on: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
      off: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
    }
    // setImmediate is not faked, so this yields to the real event loop.
    const realSetImmediate = Reflect.get(globalThis, 'setImmediate') as (callback: () => void) => unknown
    processEvents.on('unhandledRejection', unhandled)
    try {
      const first = connect({})
      latestSocket().open()
      await first

      latestSocket().emitClose(1006)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(FakeWebSocket.instances).toHaveLength(2)

      latestSocket().fail()
      // Node reports unhandled rejections on a later macrotask, so yield to the real event loop once.
      await new Promise<void>((resolve) => { realSetImmediate(resolve) })
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      processEvents.off('unhandledRejection', unhandled)
    }
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../runtimeConfig', () => ({ getWSUrl: () => 'ws://test' }))
vi.mock('../../stores/connectionStatus', () => ({ setConnectionStatus: vi.fn() }))
vi.mock('../debugLog', () => ({
  addMsg: vi.fn(), addAudioChunk: vi.fn(), startSession: vi.fn(), endSession: vi.fn(),
  addRuntimeEvent: vi.fn(), hasActiveSession: () => false,
}))

class FakeWebSocket {
  static OPEN = 1
  static latest: FakeWebSocket | null = null
  constructor() { FakeWebSocket.latest = this }
  readyState = FakeWebSocket.OPEN
  sent: string[] = []
  onopen: (() => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  binaryType = ''
  send(value: string) { this.sent.push(value) }
  close() { this.readyState = 3; this.onclose?.() }
}

vi.stubGlobal('WebSocket', FakeWebSocket)

import { connect, disconnect, sendStart } from '../websocket'

describe('WebSocket speech language serialization', () => {
  beforeEach(() => disconnect())

  it('serializes auto and omits an absent language', async () => {
    const connection = connect({})
    FakeWebSocket.latest?.onopen?.()
    await connection
    expect(sendStart({ language: 'auto' })).toBe(true)
    expect(JSON.parse(FakeWebSocket.latest?.sent[0] ?? '{}').language).toBe('auto')
    expect(sendStart()).toBe(true)
    expect(JSON.parse(FakeWebSocket.latest?.sent[1] ?? '{}')).not.toHaveProperty('language')
  })
})

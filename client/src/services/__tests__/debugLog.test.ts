import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../bridge', () => ({
  appendDebugLog: vi.fn(),
}))

import { appendDebugLog } from '../bridge'
import {
  addAudioChunk,
  addRuntimeEvent,
  clearRuntimeEvents,
  clearSessions,
  getRuntimeEvents,
  getSessionAudioBlob,
  getSessions,
  startSession,
} from '../debugLog'

describe('runtime event allowlist', () => {
  beforeEach(() => {
    clearRuntimeEvents()
    vi.mocked(appendDebugLog).mockClear()
  })

  it('drops an ordinary info event from a work-mode source', () => {
    addRuntimeEvent('info', 'server', 'Custom AI cleanup started', { provider: 'ollama' })

    expect(getRuntimeEvents()).toHaveLength(0)
    expect(appendDebugLog).not.toHaveBeenCalled()
  })

  it.each(['server', 'cloud_api', 'local', 'history', 'system_audio'])(
    'keeps and mirrors the ai.outcome record written by the %s source',
    (source) => {
      addRuntimeEvent('info', source, 'ai.outcome', { status: 'applied', attempted: true })

      expect(getRuntimeEvents()).toHaveLength(1)
      expect(getRuntimeEvents()[0]).toMatchObject({ source, message: 'ai.outcome', level: 'info' })
      expect(appendDebugLog).toHaveBeenCalledTimes(1)
      expect(appendDebugLog).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'runtime',
        message: 'ai.outcome',
        detail: { status: 'applied', attempted: true },
      }))
    },
  )

  it('keeps warnings from any source', () => {
    addRuntimeEvent('warn', 'server', 'Anything went wrong')

    expect(getRuntimeEvents()).toHaveLength(1)
  })
})

describe('session audio blob', () => {
  beforeEach(() => {
    clearSessions()
    vi.mocked(appendDebugLog).mockClear()
  })

  it('returns null when the session has no audio or only a zero-length chunk', () => {
    startSession()

    expect(getSessionAudioBlob(getSessions()[0])).toBeNull()

    addAudioChunk(new ArrayBuffer(0))
    expect(getSessionAudioBlob(getSessions()[0])).toBeNull()
  })

  it('writes chunks into a WAV blob in order after the 44-byte header', async () => {
    startSession()
    addAudioChunk(new Uint8Array([1, 2, 3, 4]).buffer)
    addAudioChunk(new Uint8Array([5, 6]).buffer)

    const blob = getSessionAudioBlob(getSessions()[0])

    expect(blob).not.toBeNull()
    expect(blob!.size).toBe(44 + 6)
    const bytes = new Uint8Array(await blob!.arrayBuffer())
    const view = new DataView(bytes.buffer)
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF')
    expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE')
    expect(String.fromCharCode(...bytes.slice(36, 40))).toBe('data')
    expect(view.getUint32(40, true)).toBe(6)
    expect(Array.from(bytes.slice(44))).toEqual([1, 2, 3, 4, 5, 6])
  })
})

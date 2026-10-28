import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptionCallbacks } from '../types'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
  connect: vi.fn(),
  sendStart: vi.fn(),
  sendStop: vi.fn(),
  sendAudio: vi.fn(),
  disconnect: vi.fn(),
  addRuntimeEvent: vi.fn(),
}))

vi.mock('../../store', () => ({
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
}))
vi.mock('../../debugLog', () => ({
  addRuntimeEvent: (...args: unknown[]) => mocks.addRuntimeEvent(...args),
}))
vi.mock('../../websocket', () => ({
  connect: (...args: unknown[]) => mocks.connect(...args),
  sendStart: (...args: unknown[]) => mocks.sendStart(...args),
  sendStop: (...args: unknown[]) => mocks.sendStop(...args),
  sendAudio: (...args: unknown[]) => mocks.sendAudio(...args),
  disconnect: (...args: unknown[]) => mocks.disconnect(...args),
  isConnected: () => true,
  supportsTextContext: () => false,
}))
vi.mock('../serverAiSource', () => ({
  getRuntimeServerAiSource: () => 'managed',
  loadServerAiSource: async () => 'managed',
}))
vi.mock('../clientAiPolish', () => ({
  polishWithClientAi: vi.fn(),
}))

import { ServerProvider } from '../ServerProvider'

// 200 ms of 16 kHz 16-bit mono audio. Hard-coded on purpose: the test pins the wire contract, so it must not follow
// a change of the production constant.
const BATCH_BYTES = 6400
const FRAME_BYTES = 256

// One ordered log of everything that reaches the wire, so a test asserts the exact sequence of packets.
let wire: string[]
let packets: Uint8Array[]
let packetBuffers: ArrayBuffer[]
let wireCallbacks: TranscriptionCallbacks | undefined

function frame(fill: number, size = FRAME_BYTES): ArrayBuffer {
  return new Uint8Array(size).fill(fill).buffer
}

function concat(buffers: ArrayBuffer[]): Uint8Array {
  const total = buffers.reduce((sum, buffer) => sum + buffer.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const buffer of buffers) {
    out.set(new Uint8Array(buffer), offset)
    offset += buffer.byteLength
  }
  return out
}

// Frames with a distinct fill value each, so any reordering, loss or duplication changes the concatenated bytes.
function distinctFrames(count: number, size = FRAME_BYTES, firstFill = 1): ArrayBuffer[] {
  return Array.from({ length: count }, (_, index) => frame(firstFill + index, size))
}

function pushAll(provider: ServerProvider, frames: ArrayBuffer[]) {
  for (const buffer of frames) provider.sendAudio(buffer)
}

async function connectedProvider(): Promise<ServerProvider> {
  const provider = new ServerProvider()
  await provider.connect({})
  return provider
}

describe('ServerProvider audio batching', () => {
  beforeEach(() => {
    wire = []
    packets = []
    packetBuffers = []
    wireCallbacks = undefined
    mocks.getSetting.mockReset().mockImplementation(async (_key: string, fallback: unknown) => fallback)
    mocks.connect.mockReset().mockImplementation(async (callbacks: TranscriptionCallbacks) => {
      wireCallbacks = callbacks
    })
    mocks.sendStart.mockReset().mockReturnValue(true)
    mocks.sendStop.mockReset().mockImplementation(() => {
      wire.push('stop')
      return true
    })
    mocks.sendAudio.mockReset().mockImplementation((buffer: ArrayBuffer) => {
      wire.push(`audio:${buffer.byteLength}`)
      packets.push(new Uint8Array(buffer.slice(0)))
      packetBuffers.push(buffer)
    })
    mocks.disconnect.mockReset()
    mocks.addRuntimeEvent.mockReset()
  })

  describe('batching', () => {
    it('T1: holds 25 frames of 256 bytes back until the 25th, then sends one 6400-byte packet in order', async () => {
      const provider = await connectedProvider()
      expect(provider.start({ runId: 1 })).toBe(true)
      const frames = distinctFrames(25)

      pushAll(provider, frames.slice(0, 24))
      expect(wire).toEqual([])

      provider.sendAudio(frames[24])
      expect(wire).toEqual([`audio:${BATCH_BYTES}`])
      expect(packets[0]).toEqual(concat(frames))

      expect(provider.stop()).toBe(true)
      expect(wire).toEqual([`audio:${BATCH_BYTES}`, 'stop'])
    })

    it('sends nothing at 6399 pending bytes and flushes as soon as one more byte completes the batch', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })

      provider.sendAudio(frame(7, BATCH_BYTES - 1))
      expect(wire).toEqual([])

      provider.sendAudio(frame(9, 1))
      expect(wire).toEqual([`audio:${BATCH_BYTES}`])
      expect(packets[0][0]).toBe(7)
      expect(packets[0][BATCH_BYTES - 2]).toBe(7)
      expect(packets[0][BATCH_BYTES - 1]).toBe(9)
    })

    it('T3: frames that add up to exactly one batch are followed by stop with no extra empty packet', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const frames = distinctFrames(10, 640)

      pushAll(provider, frames)
      expect(provider.stop()).toBe(true)

      expect(wire).toEqual([`audio:${BATCH_BYTES}`, 'stop'])
      expect(packets[0]).toEqual(concat(frames))
    })

    it('lets a batch exceed the threshold by less than one frame and keeps the remainder for the next batch', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      // 24 frames are 6144 bytes; the 25th pushes the batch to 6144 + 1000 = 7144 bytes.
      const frames = [...distinctFrames(24), frame(100, 1000), frame(101)]

      pushAll(provider, frames)
      expect(wire).toEqual(['audio:7144'])
      expect(packets[0]).toEqual(concat(frames.slice(0, 25)))

      expect(provider.stop()).toBe(true)
      expect(wire).toEqual(['audio:7144', `audio:${FRAME_BYTES}`, 'stop'])
      expect(packets[1]).toEqual(new Uint8Array(frames[25]))
    })

    it('T8: keeps order and the total byte count across batches for odd fallback-path frame sizes', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const frames = Array.from({ length: 200 }, (_, index) => frame((index % 250) + 1, index % 2 === 0 ? 84 : 86))
      const totalBytes = frames.reduce((sum, buffer) => sum + buffer.byteLength, 0)

      pushAll(provider, frames)
      expect(provider.stop()).toBe(true)

      expect(wire[wire.length - 1]).toBe('stop')
      expect(packets.length).toBeGreaterThan(1)
      for (const packet of packets.slice(0, -1)) {
        expect(packet.byteLength).toBeGreaterThanOrEqual(BATCH_BYTES)
        expect(packet.byteLength).toBeLessThan(BATCH_BYTES + 86)
      }
      expect(packets[packets.length - 1].byteLength).toBeLessThan(BATCH_BYTES + 86)
      expect(packets.reduce((sum, packet) => sum + packet.byteLength, 0)).toBe(totalBytes)
      expect(concat(packets.map((packet) => packet.buffer as ArrayBuffer))).toEqual(concat(frames))
    })
  })

  describe('copying', () => {
    it('T7: passes one large buffer through as the very same ArrayBuffer and sends no further audio on stop', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const large = frame(0x5a, 32000)

      provider.sendAudio(large)

      expect(mocks.sendAudio).toHaveBeenCalledTimes(1)
      expect(packetBuffers[0]).toBe(large)
      expect(wire).toEqual(['audio:32000'])

      expect(provider.stop()).toBe(true)
      expect(wire).toEqual(['audio:32000', 'stop'])
      expect(mocks.sendAudio).toHaveBeenCalledTimes(1)
    })

    it('passes a lone pending frame through without a copy when stop flushes it', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const single = frame(0x33)

      provider.sendAudio(single)
      expect(provider.stop()).toBe(true)

      expect(wire).toEqual([`audio:${FRAME_BYTES}`, 'stop'])
      expect(packetBuffers[0]).toBe(single)
    })

    it('merges pending frames and a large buffer into one packet in arrival order', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const small = distinctFrames(3)
      const large = frame(0x70, 32000)

      pushAll(provider, [...small, large])

      expect(wire).toEqual(['audio:32768'])
      expect(packets[0]).toEqual(concat([...small, large]))
    })

    it('does not mutate or detach the buffers it was given', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const frames = distinctFrames(25)
      const snapshots = frames.map((buffer) => new Uint8Array(buffer.slice(0)))

      pushAll(provider, frames)

      frames.forEach((buffer, index) => {
        expect(buffer.byteLength).toBe(FRAME_BYTES)
        expect(new Uint8Array(buffer)).toEqual(snapshots[index])
      })
    })

    it('ignores empty buffers so that they never become a pending tail or an empty packet', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })

      provider.sendAudio(new ArrayBuffer(0))
      expect(provider.stop()).toBe(true)
      expect(wire).toEqual(['stop'])

      wire.length = 0
      provider.start({ runId: 2 })
      const single = frame(0x44)
      provider.sendAudio(new ArrayBuffer(0))
      provider.sendAudio(single)
      provider.sendAudio(new ArrayBuffer(0))
      expect(provider.stop()).toBe(true)
      expect(wire).toEqual([`audio:${FRAME_BYTES}`, 'stop'])
      expect(packetBuffers[0]).toBe(single)
    })
  })

  describe('stop', () => {
    it('T2: sends the pending tail before the stop command, and only stop when nothing is pending', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const frames = distinctFrames(2)

      pushAll(provider, frames)
      expect(wire).toEqual([])
      expect(provider.stop()).toBe(true)
      expect(wire).toEqual([`audio:${2 * FRAME_BYTES}`, 'stop'])
      expect(packets[0]).toEqual(concat(frames))

      wire.length = 0
      packets.length = 0
      provider.start({ runId: 2 })
      expect(provider.stop()).toBe(true)
      expect(wire).toEqual(['stop'])
    })

    it('flushes the tail before stop even when stop disables the AI stage', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })

      provider.sendAudio(frame(1))
      expect(provider.stop({ disableAi: true, disableAiCause: 'below_min_duration' })).toBe(true)

      expect(wire).toEqual([`audio:${FRAME_BYTES}`, 'stop'])
      expect(mocks.sendStop).toHaveBeenCalledWith(expect.objectContaining({ disableAi: true }))
    })
  })

  describe('discarding pending audio', () => {
    it('T4: sends only the new run bytes after cancel() and a new start()', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      pushAll(provider, distinctFrames(3, FRAME_BYTES, 0xa0))

      provider.cancel()
      expect(provider.start({ runId: 2 })).toBe(true)
      const fresh = distinctFrames(2, FRAME_BYTES, 0x10)
      pushAll(provider, fresh)
      expect(provider.stop()).toBe(true)

      expect(wire).toEqual([`audio:${2 * FRAME_BYTES}`, 'stop'])
      expect(packets[0]).toEqual(concat(fresh))
    })

    it('T5: never sends bytes pending when the wire reports an error, in the old or in a later run', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      pushAll(provider, distinctFrames(3, FRAME_BYTES, 0xa0))

      wireCallbacks?.onError?.('boom')

      // Capture keeps delivering after the reset until the recorder tears it down; those frames start a clean batch.
      const afterError = distinctFrames(25, FRAME_BYTES, 0x20)
      pushAll(provider, afterError)
      expect(wire).toEqual([`audio:${BATCH_BYTES}`])
      expect(packets[0]).toEqual(concat(afterError))

      expect(provider.start({ runId: 2 })).toBe(true)
      const fresh = distinctFrames(2, FRAME_BYTES, 0x60)
      pushAll(provider, fresh)
      expect(provider.stop()).toBe(true)
      expect(wire).toEqual([`audio:${BATCH_BYTES}`, `audio:${2 * FRAME_BYTES}`, 'stop'])
      expect(packets[1]).toEqual(concat(fresh))
    })

    it.each([
      { name: 'cancel()', abandon: (provider: ServerProvider) => provider.cancel() },
      { name: 'disconnect()', abandon: (provider: ServerProvider) => provider.disconnect() },
      { name: 'a wire error', abandon: () => wireCallbacks?.onError?.('boom') },
      { name: 'the wire done event', abandon: () => wireCallbacks?.onDone?.() },
    ])('drops the pending tail on $name so that neither stop nor later frames send it', async ({ abandon }) => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      pushAll(provider, distinctFrames(3, FRAME_BYTES, 0xa0))

      abandon(provider)
      expect(provider.stop()).toBe(true)
      expect(wire).toEqual(['stop'])

      wire.length = 0
      provider.start({ runId: 2 })
      pushAll(provider, distinctFrames(3, FRAME_BYTES, 0xa0))
      abandon(provider)
      const later = distinctFrames(25, FRAME_BYTES, 0x20)
      pushAll(provider, later)
      expect(wire).toEqual([`audio:${BATCH_BYTES}`])
      expect(packets[0]).toEqual(concat(later))
    })

    it('leaves nothing pending when the start command could not be sent', async () => {
      const provider = await connectedProvider()
      mocks.sendStart.mockReturnValue(false)
      pushAll(provider, distinctFrames(3, FRAME_BYTES, 0xa0))

      expect(provider.start({ runId: 1 })).toBe(false)
      expect(provider.stop()).toBe(true)

      expect(wire).toEqual(['stop'])
    })

    it('T6: never sends frames that arrived before start(), even without a cancel in between', async () => {
      const provider = await connectedProvider()
      // Capture starts in parallel with connect, so frames can precede start(); the wire layer drops them while no
      // session is started, and the provider has to keep doing the same.
      pushAll(provider, distinctFrames(3, FRAME_BYTES, 0xe0))
      expect(wire).toEqual([])

      expect(provider.start({ runId: 1 })).toBe(true)
      const postStart = frame(0x11)
      provider.sendAudio(postStart)
      expect(provider.stop()).toBe(true)

      expect(wire).toEqual([`audio:${FRAME_BYTES}`, 'stop'])
      expect(packets[0]).toEqual(new Uint8Array(postStart))
    })

    it('T9: never sends a frame that arrives after stop() and before the next start()', async () => {
      const provider = await connectedProvider()
      provider.start({ runId: 1 })
      const first = frame(0x01)
      provider.sendAudio(first)
      expect(provider.stop()).toBe(true)
      expect(wire).toEqual([`audio:${FRAME_BYTES}`, 'stop'])

      const late = frame(0x7f)
      provider.sendAudio(late)
      expect(wire).toEqual([`audio:${FRAME_BYTES}`, 'stop'])

      expect(provider.start({ runId: 2 })).toBe(true)
      const second = frame(0x02)
      provider.sendAudio(second)
      expect(provider.stop()).toBe(true)

      expect(wire).toEqual([`audio:${FRAME_BYTES}`, 'stop', `audio:${FRAME_BYTES}`, 'stop'])
      expect(packets[0]).toEqual(new Uint8Array(first))
      expect(packets[1]).toEqual(new Uint8Array(second))
      expect(packets.some((packet) => packet.includes(0x7f))).toBe(false)
    })
  })
})

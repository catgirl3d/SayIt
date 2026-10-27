import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { uint8ArrayToBase64 } from '../encoding'

interface NodeBuffer {
  toString(encoding: 'base64'): string
  equals(other: NodeBuffer): boolean
}

interface NodeBufferConstructor {
  from(input: Uint8Array | string, encoding?: 'base64'): NodeBuffer
}

declare const Buffer: NodeBufferConstructor

function createDeterministicBytes(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length)
  let state = seed >>> 0

  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
    bytes[i] = state >>> 24
  }

  return bytes
}

function expectBase64Encoding(bytes: Uint8Array): void {
  const result = uint8ArrayToBase64(bytes)

  expect(result).toBe(Buffer.from(bytes).toString('base64'))
  expect(Buffer.from(result, 'base64').equals(Buffer.from(bytes))).toBe(true)
}

// The runtime may or may not ship Uint8Array.prototype.toBase64, so each suite pins it explicitly.
const originalToBase64 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, 'toBase64')

function setNativeToBase64(method: ((this: Uint8Array) => string) | undefined): void {
  Object.defineProperty(Uint8Array.prototype, 'toBase64', { value: method, configurable: true, writable: true })
}

function restoreNativeToBase64(): void {
  if (originalToBase64) Object.defineProperty(Uint8Array.prototype, 'toBase64', originalToBase64)
  else Reflect.deleteProperty(Uint8Array.prototype, 'toBase64')
}

describe('uint8ArrayToBase64 with a native encoder', () => {
  afterEach(restoreNativeToBase64)

  it('delegates to Uint8Array.prototype.toBase64 when the runtime provides it', () => {
    const toBase64 = vi.fn(function (this: Uint8Array) {
      return Buffer.from(this).toString('base64')
    })
    setNativeToBase64(toBase64)
    const bytes = createDeterministicBytes(20_000, 0x0bad_cafe)

    expect(uint8ArrayToBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'))
    expect(toBase64).toHaveBeenCalledTimes(1)
    expect(toBase64.mock.contexts[0]).toBe(bytes)
  })
})

describe('uint8ArrayToBase64 block fallback', () => {
  beforeEach(() => setNativeToBase64(undefined))
  afterEach(restoreNativeToBase64)

  it('encodes only the bytes of a subarray view across a chunk boundary', () => {
    const backing = createDeterministicBytes(20_000, 0x5eed_0001)
    expectBase64Encoding(backing.subarray(3, 8192 + 7))
  })

  it('encodes an empty array', () => {
    expectBase64Encoding(new Uint8Array(0))
  })

  it('encodes one byte', () => {
    expectBase64Encoding(new Uint8Array([0]))
  })

  it('encodes two bytes', () => {
    expectBase64Encoding(new Uint8Array([0, 255]))
  })

  it('encodes three bytes', () => {
    expectBase64Encoding(new Uint8Array([0, 127, 255]))
  })

  it.each([8191, 8192, 8193, 16383, 16384, 16385])(
    'matches Node Buffer for %i bytes around chunk boundaries',
    (length) => {
      expectBase64Encoding(createDeterministicBytes(length, length))
    },
  )

  it.each([
    { length: 20_000, seed: 0x1234_5678 },
    { length: 1_000_000, seed: 0x8765_4321 },
  ])('encodes deterministic pseudo-random data of $length bytes', ({ length, seed }) => {
    expectBase64Encoding(createDeterministicBytes(length, seed))
  })
})

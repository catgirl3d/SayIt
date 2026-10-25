import { describe, expect, it } from 'vitest'
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

describe('uint8ArrayToBase64', () => {
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

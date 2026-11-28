import { describe, expect, it } from 'vitest'
import { concatByteChunks } from '../bytes'

function values(bytes: Uint8Array): number[] {
  return Array.from(bytes)
}

function expectSameBytes(actual: Uint8Array, expected: Uint8Array): void {
  expect(actual.length).toBe(expected.length)
  for (let i = 0; i < expected.length; i++) {
    if (actual[i] !== expected[i]) throw new Error(`byte ${i} differs: ${actual[i]} !== ${expected[i]}`)
  }
}

describe('concatByteChunks', () => {
  it('returns an empty array for empty input', () => {
    const result = concatByteChunks([])

    expect(result).toEqual(new Uint8Array(0))
    expect(result.buffer.byteLength).toBe(0)
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('copies a single ArrayBuffer chunk', () => {
    const chunk = new Uint8Array([1, 2, 3]).buffer

    expect(values(concatByteChunks([chunk]))).toEqual([1, 2, 3])
  })

  it('concatenates multiple chunks in input order', () => {
    const result = concatByteChunks([
      new Uint8Array([1, 2]),
      new Uint8Array([3]).buffer,
      new Uint8Array([4, 5, 6]),
    ])

    expect(values(result)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('copies only the visible bytes of a subarray view', () => {
    const backing = new Uint8Array([9, 8, 1, 2, 3, 4, 7, 6])
    const view = new Uint8Array(backing.buffer, 2, 4)

    const result = concatByteChunks([view])

    expect(values(result)).toEqual([1, 2, 3, 4])
    expect(result.buffer.byteLength).toBe(4)
  })

  it('returns a fresh exact-length buffer at offset zero', () => {
    const first = new Uint8Array([1, 2, 3])

    const result = concatByteChunks([first, new Uint8Array([4, 5])])

    expect(result.byteOffset).toBe(0)
    expect(result.buffer.byteLength).toBe(5)
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
    expect(result.buffer).not.toBe(first.buffer)
  })

  it('does not mutate the inputs, and results do not alias them', () => {
    const input = new Uint8Array([1, 2, 3])

    const result = concatByteChunks([input])

    expect(values(input)).toEqual([1, 2, 3])
    result[0] = 99
    expect(input[0]).toBe(1)
  })

  it('copies the visible bytes of a DataView with a non-zero offset and explicit length', () => {
    const backing = new Uint8Array([9, 8, 7, 1, 2, 3, 6, 5])
    const view = new DataView(backing.buffer, 2, 4)

    expect(values(concatByteChunks([view]))).toEqual([7, 1, 2, 3])
  })

  it('copies the raw bytes of a Uint16Array view', () => {
    const words = new Uint16Array([0x0201, 0x0403])
    const raw = new Uint8Array(words.buffer, words.byteOffset, words.byteLength)
    const before = values(raw)

    const result = concatByteChunks([words])

    expect(values(result)).toEqual(before)
    expect(values(raw)).toEqual(before)
  })

  it('copies a bare SharedArrayBuffer', () => {
    const shared = new SharedArrayBuffer(3)
    new Uint8Array(shared).set([4, 5, 6])

    const result = concatByteChunks([shared])

    expect(values(result)).toEqual([4, 5, 6])
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
    expect(result.buffer).not.toBe(shared)
  })

  it('copies only the visible bytes of a SharedArrayBuffer-backed view', () => {
    const shared = new SharedArrayBuffer(6)
    new Uint8Array(shared).set([9, 1, 2, 3, 8, 7])
    const view = new Uint8Array(shared, 1, 3)

    const result = concatByteChunks([view])

    expect(values(result)).toEqual([1, 2, 3])
    expect(result.buffer).toBeInstanceOf(ArrayBuffer)
  })

  it('skips a zero-length chunk in the middle', () => {
    const result = concatByteChunks([
      new Uint8Array([1]),
      new Uint8Array(0),
      new Uint8Array([2]),
    ])

    expect(values(result)).toEqual([1, 2])
  })

  it('concatenates about two megabytes of mixed chunk kinds', () => {
    const direct = new Uint8Array(1_200_000)
    for (let i = 0; i < direct.length; i++) direct[i] = i & 0xff

    const viewBacking = new Uint8Array(700_000)
    for (let i = 0; i < viewBacking.length; i++) viewBacking[i] = (i + 1) & 0xff
    const view = viewBacking.subarray(100_000, 600_000)

    const shared = new SharedArrayBuffer(300_000)
    const sharedBytes = new Uint8Array(shared)
    for (let i = 0; i < sharedBytes.length; i++) sharedBytes[i] = (i + 2) & 0xff

    const expected = new Uint8Array(direct.length + view.length + shared.byteLength)
    expected.set(direct, 0)
    expected.set(view, direct.length)
    expected.set(sharedBytes, direct.length + view.length)
    const directBefore = direct.slice()
    const viewBefore = view.slice()
    const sharedBefore = sharedBytes.slice()

    const result = concatByteChunks([direct.buffer, view, shared])

    expectSameBytes(result, expected)
    expectSameBytes(direct, directBefore)
    expectSameBytes(view, viewBefore)
    expectSameBytes(sharedBytes, sharedBefore)
  })
})

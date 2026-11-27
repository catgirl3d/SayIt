import { describe, expect, it } from 'vitest'
import { joinPCMChunks } from '../debugUtils'

function rawBytes(pcm: Int16Array): number[] {
  return Array.from(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength))
}

describe('joinPCMChunks', () => {
  it('joins even chunks in order and keeps an exact-length buffer', () => {
    const pcm = joinPCMChunks([
      new Uint8Array([1, 2, 3, 4]).buffer,
      new Uint8Array([5, 6]).buffer,
    ])

    expect(pcm).not.toBeNull()
    expect(rawBytes(pcm!)).toEqual([1, 2, 3, 4, 5, 6])
    expect(pcm!.buffer.byteLength).toBe(6)
  })

  it('drops a trailing odd byte', () => {
    const pcm = joinPCMChunks([
      new Uint8Array([1, 2, 3]).buffer,
      new Uint8Array([4, 5]).buffer,
    ])

    expect(pcm).not.toBeNull()
    expect(rawBytes(pcm!)).toEqual([1, 2, 3, 4])
    expect(pcm!.buffer.byteLength).toBe(4)
  })

  it('returns null for empty input', () => {
    expect(joinPCMChunks([])).toBeNull()
  })

  it('returns null for a single byte', () => {
    expect(joinPCMChunks([new Uint8Array([7]).buffer])).toBeNull()
  })
})

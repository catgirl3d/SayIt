export type ByteChunk = ArrayBufferLike | ArrayBufferView

/**
 * Concatenate byte chunks into one fresh exact-length buffer in input order.
 * Accepts ArrayBuffer, SharedArrayBuffer, and any ArrayBufferView. Views contribute only their visible bytes
 * (byteOffset and byteLength are respected), and inputs are never mutated. The result is always a fresh
 * ArrayBuffer-backed Uint8Array whose buffer length equals its byteLength and which starts at offset zero.
 * Input lengths must stay stable for the duration of the call (growable SharedArrayBuffers are not synchronized).
 * Callers must pass real ArrayBuffer, SharedArrayBuffer, or ArrayBufferView values; structural lookalikes are not
 * detected at runtime because no current caller passes them.
 *
 * The return annotation is deliberately omitted: inference from `new Uint8Array(totalBytes)` keeps the result
 * ArrayBuffer-backed. Typed-array generic annotations cannot be used because client/package.json supports
 * TypeScript 5.6.3, where those generics do not exist.
 */
export function concatByteChunks(chunks: readonly ByteChunk[]) {
  let totalBytes = 0
  for (const chunk of chunks) totalBytes += chunk.byteLength

  const merged = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    const view = ArrayBuffer.isView(chunk)
      ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : new Uint8Array(chunk)
    merged.set(view, offset)
    offset += view.byteLength
  }

  return merged
}

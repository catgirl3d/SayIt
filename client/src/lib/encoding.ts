/** ES2026 adds Uint8Array.prototype.toBase64; the ES2020 lib this project compiles against does not declare it. */
type MaybeNativeBase64 = Uint8Array & { toBase64?: () => string }

/**
 * Encode bytes as standard padded base64.
 * Uses the engine's native encoder when the runtime has it (current WebView2/Chromium does, and it is
 * an order of magnitude faster on multi-megabyte recordings); older runtimes fall back to block conversion.
 * Both paths produce byte-for-byte identical output.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const maybeNative = bytes as MaybeNativeBase64
  if (typeof maybeNative.toBase64 === 'function') return maybeNative.toBase64()
  return encodeInBlocks(bytes)
}

/**
 * Decode base64 to bytes with atob semantics: standard base64 with optional padding, ASCII whitespace ignored,
 * and invalid input throws without the error being swallowed.
 *
 * The return annotation is deliberately omitted: inference from `new Uint8Array(binary.length)` keeps the result
 * ArrayBuffer-backed. Typed-array generic annotations cannot be used because client/package.json supports
 * TypeScript 5.6.3, where those generics do not exist.
 */
export function base64ToUint8Array(base64: string) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Convert bounded chunks with apply to avoid per-byte string concatenation.
 * Joining the binary chunks before btoa preserves byte-for-byte identical base64 output.
 */
function encodeInBlocks(bytes: Uint8Array): string {
  const CHUNK_SIZE = 8192
  const parts: string[] = []

  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const end = Math.min(i + CHUNK_SIZE, bytes.length)
    const chunk = bytes.subarray(i, end)
    // Uint8Array is array-like; apply avoids the slow typed-array iterator used by spread.
    parts.push(String.fromCharCode.apply(null, chunk as unknown as number[]))
  }

  return btoa(parts.join(''))
}

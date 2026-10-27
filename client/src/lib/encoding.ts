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

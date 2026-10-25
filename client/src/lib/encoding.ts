/**
 * Convert bounded chunks with apply to avoid per-byte string concatenation.
 * Joining the binary chunks before btoa preserves byte-for-byte identical base64 output.
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
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

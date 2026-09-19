import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkVersionUpdate } from '@/features/update/updateChecker'
import { PROJECT_UPDATE_MANIFEST_URL } from '@/services/projectLinks'
import { UPDATE_MANIFEST_FILENAME } from '../scripts/generate-update-manifest.mjs'

/**
 * Ties the release tooling to the runtime validator.
 *
 * The manifest URL/version/filename rules exist independently in the Node generator,
 * the TypeScript checker, the Rust downloader, and the release workflow. The
 * per-language tests pin each copy in isolation, but nothing forced the generator's
 * OUTPUT to be accepted by the validator that runs in the app — a one-sided edit
 * would publish manifests the client rejects, and updates would simply stop.
 * This test closes that seam: run the real generator CLI, then feed its exact file
 * through the real checker.
 *
 * Lives outside src/ on purpose: it uses Node built-ins, and the app tsconfig has no
 * Node type environment. The vitest include pattern covers tests/ for exactly this.
 */
const GENERATOR_PATH = fileURLToPath(new URL('../scripts/generate-update-manifest.mjs', import.meta.url))

describe('release generator output satisfies the runtime manifest validator', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('accepts a generated manifest and reports the update', async () => {
    // The stable download URL and the generator must agree on the manifest file name,
    // or the client would silently stop finding updates.
    expect(PROJECT_UPDATE_MANIFEST_URL.endsWith(`/${UPDATE_MANIFEST_FILENAME}`)).toBe(true)

    const dir = mkdtempSync(join(tmpdir(), 'sayit-manifest-contract-'))
    try {
      const installerPath = join(dir, 'SayIt_0.2.1_x64-setup.exe')
      const manifestPath = join(dir, UPDATE_MANIFEST_FILENAME)
      writeFileSync(installerPath, 'installer-bytes')

      execFileSync(process.execPath, [
        GENERATOR_PATH,
        '--version', '0.2.1',
        '--repository', 'catgirl3d/SayIt',
        '--installer', installerPath,
        '--release-date', '2026-09-19T00:00:00.000Z',
        '--output', manifestPath,
      ])

      const generated = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => generated,
      })
      vi.stubGlobal('fetch', fetchMock)

      const info = await checkVersionUpdate('0.2.0')

      expect(fetchMock).toHaveBeenCalledWith(
        PROJECT_UPDATE_MANIFEST_URL,
        expect.objectContaining({ cache: 'no-store' }),
      )
      expect(info.error).toBeNull()
      expect(info.hasUpdate).toBe(true)
      expect(info.latestVersion).toBe('0.2.1')
      expect(info.downloadUrl).toBe(generated.url)
      expect(info.sha512).toBe(generated.sha512)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

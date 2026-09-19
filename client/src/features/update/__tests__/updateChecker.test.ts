import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_RELEASES_URL, PROJECT_UPDATE_MANIFEST_URL } from '@/services/projectLinks'
import { checkVersionUpdate, compareVersions, type VersionInfo } from '../updateChecker'

// Every manifest fixture starts from one canonical valid payload; a rejection case
// overrides exactly one field so a failure pins the violated rule, not a typo cascade.
const VALID_SHA512 = btoa('v'.repeat(64))

function validManifest() {
  return {
    version: '0.2.1',
    releaseDate: '2026-09-16T00:00:00.000Z',
    url: `${PROJECT_RELEASES_URL}/download/v0.2.1/SayIt_0.2.1_x64-setup.exe`,
    sha512: VALID_SHA512,
  }
}

function manifestWith(overrides: Record<string, unknown>) {
  return { ...validManifest(), ...overrides }
}

function respondWith(manifest: unknown, status = 200) {
  const fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => manifest,
  })
  return fetchMock
}

async function check(currentVersion: string, manifest: unknown, status = 200): Promise<VersionInfo> {
  const fetchMock = respondWith(manifest, status)
  const info = await checkVersionUpdate(currentVersion)
  expect(fetchMock, 'a check must hit exactly one URL, the pinned fork manifest').toHaveBeenCalledTimes(1)
  expect(fetchMock).toHaveBeenCalledWith(
    PROJECT_UPDATE_MANIFEST_URL,
    expect.objectContaining({ cache: 'no-store' }),
  )
  return info
}

/** Every rejected manifest must fail closed: no version, no URL, no hash. */
function expectRejected(info: VersionInfo, expectedError = 'Invalid fork update manifest') {
  expect(info.hasUpdate).toBe(false)
  expect(info.latestVersion).toBeNull()
  expect(info.downloadUrl).toBeNull()
  expect(info.releaseDate).toBeNull()
  expect(info.sha512).toBeNull()
  expect(info.error).toBe(expectedError)
}

describe('project update manifest URL', () => {
  it('pins the manifest to the fork releases latest-download URL', () => {
    expect(PROJECT_UPDATE_MANIFEST_URL).toBe(
      'https://github.com/catgirl3d/SayIt/releases/latest/download/latest-win32-x64.json',
    )
    expect(PROJECT_UPDATE_MANIFEST_URL).toBe(`${PROJECT_RELEASES_URL}/latest/download/latest-win32-x64.json`)
  })
})

describe('compareVersions', () => {
  it('treats a two-digit patch as newer than a one-digit one', () => {
    expect(compareVersions('0.2.9', '0.2.10')).toBeGreaterThan(0)
  })

  it('returns 0 for equal versions', () => {
    expect(compareVersions('0.2.1', '0.2.1')).toBe(0)
  })

  it('orders across minor versions', () => {
    expect(compareVersions('0.3.0', '0.2.9')).toBeLessThan(0)
  })
})

describe('checkVersionUpdate', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports an available update with the immutable installer URL and hash', async () => {
    const info = await check('0.1.9', validManifest())
    expect(info.hasUpdate).toBe(true)
    expect(info.currentVersion).toBe('0.1.9')
    expect(info.latestVersion).toBe('0.2.1')
    expect(info.downloadUrl).toBe(validManifest().url)
    expect(info.releaseDate).toBe('2026-09-16T00:00:00.000Z')
    expect(info.sha512).toBe(VALID_SHA512)
    expect(info.error).toBeNull()
    expect(info.sourceUrl).toBe(PROJECT_UPDATE_MANIFEST_URL)
  })

  it('reports no update when the manifest version equals the current one', async () => {
    const info = await check('0.2.1', validManifest())
    expect(info.hasUpdate).toBe(false)
    expect(info.latestVersion).toBe('0.2.1')
    expect(info.downloadUrl).toBe(validManifest().url)
    expect(info.sha512).toBe(VALID_SHA512)
    expect(info.error).toBeNull()
  })

  it('rejects an installer URL pointing at the upstream backend', async () => {
    expectRejected(await check('0.1.9', manifestWith({
      url: 'https://sayitapp.site/api/desktop-updates/win32/x64/SayIt_0.2.1_x64-setup.exe',
    })))
  })

  it('rejects an installer URL from another repository', async () => {
    expectRejected(await check('0.1.9', manifestWith({
      url: 'https://github.com/crosswk/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe',
    })))
  })

  it('rejects a non-HTTPS installer URL', async () => {
    expectRejected(await check('0.1.9', manifestWith({
      url: 'http://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe',
    })))
  })

  it('rejects a URL whose tag does not match the manifest version', async () => {
    expectRejected(await check('0.1.9', manifestWith({
      url: `${PROJECT_RELEASES_URL}/download/v0.2.2/SayIt_0.2.2_x64-setup.exe`,
    })))
  })

  it('rejects a filename whose version does not match the manifest version', async () => {
    expectRejected(await check('0.1.9', manifestWith({
      url: `${PROJECT_RELEASES_URL}/download/v0.2.1/SayIt_0.2.2_x64-setup.exe`,
    })))
  })

  it.each([
    ['two segments', '0.2'],
    ['pre-release suffix', '0.2.1-beta'],
    ['leading v', 'v0.2.1'],
  ])('rejects a malformed manifest version: %s', async (_label, version) => {
    expectRejected(await check('0.1.9', manifestWith({ version })))
  })

  it('rejects an unparseable release date', async () => {
    expectRejected(await check('0.1.9', manifestWith({ releaseDate: 'not-a-date' })))
  })

  it('rejects a date-only release date', async () => {
    expectRejected(await check('0.1.9', manifestWith({ releaseDate: '2026-09-16' })))
  })

  it('rejects a release date without milliseconds', async () => {
    expectRejected(await check('0.1.9', manifestWith({ releaseDate: '2026-09-16T00:00:00Z' })))
  })

  it('rejects a release date with a non-UTC offset', async () => {
    expectRejected(await check('0.1.9', manifestWith({ releaseDate: '2026-09-16T00:00:00.000+03:00' })))
  })

  it('rejects a non-Base64 hash', async () => {
    expectRejected(await check('0.1.9', manifestWith({ sha512: '!!!not-base64!!!' })))
  })

  it('rejects a hash that does not decode to 64 bytes', async () => {
    expectRejected(await check('0.1.9', manifestWith({ sha512: btoa('v'.repeat(63)) })))
  })

  it('rejects an unpadded 64-byte digest', async () => {
    expectRejected(await check('0.1.9', manifestWith({ sha512: VALID_SHA512.replace(/==$/, '') })))
  })

  it('rejects a digest padded for a different length', async () => {
    expectRejected(await check('0.1.9', manifestWith({ sha512: VALID_SHA512.slice(0, -1) })))
  })

  it('rejects a manifest missing fields', async () => {
    expectRejected(await check('0.1.9', { version: '0.2.1' }))
  })

  it('reports HTTP failures with their status and no partial metadata', async () => {
    const info = await check('0.1.9', validManifest(), 500)
    expect(info.error).toBe('HTTP 500')
    expect(info.hasUpdate).toBe(false)
    expect(info.latestVersion).toBeNull()
    expect(info.downloadUrl).toBeNull()
    expect(info.sha512).toBeNull()
  })

  it('leaves a missing manifest (404) non-destructive: no update, no crash', async () => {
    const info = await check('0.1.9', validManifest(), 404)
    expect(info.hasUpdate).toBe(false)
    expect(info.latestVersion).toBeNull()
    expect(info.downloadUrl).toBeNull()
  })

  it('surfaces a network failure without partial metadata', async () => {
    respondWith(validManifest())
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')))
    const info = await checkVersionUpdate('0.1.9')
    expect(info.hasUpdate).toBe(false)
    expect(info.error).toContain('network down')
    expect(info.latestVersion).toBeNull()
    expect(info.downloadUrl).toBeNull()
    expect(info.sha512).toBeNull()
  })
})

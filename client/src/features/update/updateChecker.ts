// Frontend version check — fetch the pinned fork release manifest and compare version numbers.

import {
  PROJECT_UPDATE_MANIFEST_URL,
  projectReleaseInstallerUrl,
} from '@/services/projectLinks'

export interface VersionInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string | null
  downloadUrl: string | null
  releaseDate: string | null
  /** Installer SHA-512 (Base64). Re-verified by the Rust side after download. */
  sha512: string | null
  error: string | null
  /** The URL the manifest was fetched from. The fork channel is fixed, so this is constant. */
  sourceUrl: string | null
}

/**
 * Returns >0 when latest is newer than current.
 *
 * Only pure numeric dot-separated segments are recognized. Non-numeric segments
 * (pre-release suffixes and the like) are treated as 0 instead of letting NaN
 * propagate: NaN poisons every subtraction, so the loop would return NaN on the
 * first segment, and `NaN > 0` is false — an available update would be silently
 * swallowed with no error anywhere.
 */
export function compareVersions(current: string, latest: string): number {
  const parse = (value: string) => value.split('.').map((segment) => {
    const parsed = Number.parseInt(segment, 10)
    return Number.isFinite(parsed) ? parsed : 0
  })
  const a = parse(current)
  const b = parse(latest)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (b[i] || 0) - (a[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

const NUMERIC_VERSION_PATTERN = /^\d+\.\d+\.\d+$/
// Canonical Base64 of a 64-byte SHA-512 digest: exactly 88 characters, `==` padding.
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/
// Canonical UTC ISO timestamp, the exact shape `Date.toISOString()` emits (what the
// release workflow's manifest generator writes): 2026-09-16T00:00:00.000Z.
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

/**
 * Check for updates against the pinned fork release manifest (PROJECT_UPDATE_MANIFEST_URL).
 *
 * The source is deliberately fixed and independent of the speech-backend setting: the
 * backend URL is user-configurable, and a user-configurable address must never decide
 * which installer this machine is allowed to download and run. There is no fallback
 * URL either — when the manifest is missing, the result is simply "no update", never a
 * request to some other server.
 *
 * The manifest fails closed: version, release date, installer URL, and SHA-512 are all
 * mandatory, and the installer URL must be the canonical fork release asset for exactly
 * the version the manifest declares. Any deviation returns the invalid-manifest result
 * with every field null, so a half-valid manifest can never smuggle a download URL or
 * a hash past this boundary.
 */
export async function checkVersionUpdate(currentVersion: string): Promise<VersionInfo> {
  const base: VersionInfo = {
    hasUpdate: false,
    currentVersion,
    latestVersion: null,
    downloadUrl: null,
    releaseDate: null,
    sha512: null,
    error: null,
    sourceUrl: PROJECT_UPDATE_MANIFEST_URL,
  }

  try {
    const resp = await fetch(PROJECT_UPDATE_MANIFEST_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    })
    if (!resp.ok) {
      // 404 simply means no release has been published yet; other statuses are real errors.
      base.error = resp.status === 404 ? null : `HTTP ${resp.status}`
      return base
    }
    return validateManifest(base, currentVersion, await resp.json())
  } catch (err) {
    base.error = String(err)
    return base
  }
}

function validateManifest(base: VersionInfo, currentVersion: string, raw: unknown): VersionInfo {
  if (typeof raw !== 'object' || raw === null) return invalidManifest(base)
  const manifest = raw as Record<string, unknown>
  const version = manifest.version
  const releaseDate = manifest.releaseDate
  const url = manifest.url
  const sha512 = manifest.sha512

  if (
    typeof version !== 'string' ||
    !NUMERIC_VERSION_PATTERN.test(version) ||
    typeof releaseDate !== 'string' ||
    !ISO_TIMESTAMP_PATTERN.test(releaseDate) ||
    Number.isNaN(new Date(releaseDate).getTime()) ||
    typeof url !== 'string' ||
    url !== projectReleaseInstallerUrl(version) ||
    typeof sha512 !== 'string' ||
    !isSixtyFourByteSha512Base64(sha512)
  ) {
    return invalidManifest(base)
  }

  base.latestVersion = version
  base.releaseDate = releaseDate
  base.sha512 = sha512
  base.downloadUrl = url
  base.hasUpdate = compareVersions(currentVersion, version) > 0
  return base
}

function invalidManifest(base: VersionInfo): VersionInfo {
  // Every field stays null: a manifest that violates any rule must not leave a
  // partially valid download URL or hash behind for the install path to trust.
  base.error = 'Invalid fork update manifest'
  return base
}

function isSixtyFourByteSha512Base64(value: string): boolean {
  // The length/padding pattern pins the canonical encoding of a 64-byte digest;
  // the decode still runs so an inhumanly crafted pattern match cannot sneak through.
  if (!SHA512_BASE64_PATTERN.test(value)) return false
  try {
    return atob(value).length === 64
  } catch {
    return false
  }
}

#!/usr/bin/env node
/**
 * Builds the fork update manifest (latest-win32-x64.json) that the desktop client
 * fetches from the stable `releases/latest/download` URL.
 *
 * The manifest is the trust anchor between the GitHub release and the client:
 * the client validates that the installer URL is exactly the fork's immutable
 * version-tagged asset and that the SHA-512 is canonical padded Base64 decoding to
 * 64 bytes. This generator enforces the same rules, so a malformed manifest can
 * never be published in the first place.
 *
 * The manifest also carries the release notes for the version — the CHANGELOG-FORK.md
 * section that the release workflow already extracts — so the desktop app can show
 * what changed at the moment it discovers the update, without a second request. Translated
 * sections (CHANGELOG-FORK.uk.md) ride in `notesLocalized` keyed by interface locale; the
 * English `notes` stays the required source and the app's fallback, and the field is
 * omitted entirely when no translations exist.
 *
 * The repository is pinned: running the release workflow from any repository other
 * than the fork fails here instead of publishing metadata that points at the wrong
 * release assets.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { argv } from 'node:process'
import { pathToFileURL } from 'node:url'

export const FORK_REPOSITORY = 'catgirl3d/SayIt'
export const UPDATE_MANIFEST_FILENAME = 'latest-win32-x64.json'

// Exact numeric major.minor.patch, same rule as the client and the Rust downloader.
const NUMERIC_VERSION = /^\d+\.\d+\.\d+$/
// The native fetcher (src-tauri/src/commands/system.rs) rejects manifests over 64 KiB;
// the notes make the manifest tens of kilobytes, so the bound is enforced here at
// generation time. Publishing an oversized manifest would silently break update checks
// for every client.
const MAX_MANIFEST_BYTES = 64 * 1024
// Canonical UTC ISO timestamp, exactly what Date.prototype.toISOString() emits.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function installerNameForVersion(version) {
  return `SayIt_${version}_x64-setup.exe`
}

export function buildUpdateManifest({ version, repository, installerName, installerBytes, releaseDate, notes, localizedNotes }) {
  if (repository !== FORK_REPOSITORY) {
    throw new Error(`Refusing to build a manifest for repository '${repository}' (expected '${FORK_REPOSITORY}')`)
  }
  if (typeof version !== 'string' || !NUMERIC_VERSION.test(version)) {
    throw new Error(`Invalid release version '${version}' (expected numeric major.minor.patch)`)
  }
  const expectedName = installerNameForVersion(version)
  if (installerName !== expectedName) {
    throw new Error(`Installer name '${installerName}' does not match the release version (expected '${expectedName}')`)
  }
  if (typeof releaseDate !== 'string' || !ISO_TIMESTAMP.test(releaseDate) || Number.isNaN(new Date(releaseDate).getTime())) {
    throw new Error(`Invalid release date '${releaseDate}' (expected a canonical UTC ISO timestamp)`)
  }
  if (!Buffer.isBuffer(installerBytes)) {
    throw new Error('installerBytes must be a Buffer with the exact installer file bytes')
  }
  // The release notes ride inside the manifest so the app can show what changed at the
  // moment it finds the update. They are the CHANGELOG-FORK.md section for this version;
  // a manifest without them would leave the About page silent, so this fails closed.
  if (typeof notes !== 'string' || notes.trim() === '') {
    throw new Error('Invalid release notes (expected the CHANGELOG-FORK.md section for this version)')
  }
  // Localized sections are additive display data for non-English interface locales.
  // The base `notes` above stays the English source and the app's fallback, so a blank
  // or malformed translation must never ship: it either fails the release here or is
  // omitted entirely (no entry, no field).
  let normalizedLocalizedNotes = null
  if (localizedNotes !== undefined) {
    if (typeof localizedNotes !== 'object' || localizedNotes === null || Array.isArray(localizedNotes)) {
      throw new Error('Invalid localized release notes (expected a map of locale to section text)')
    }
    const entries = Object.entries(localizedNotes)
    if (entries.length > 0) {
      normalizedLocalizedNotes = {}
      for (const [locale, text] of entries) {
        if (locale.trim() === '' || typeof text !== 'string' || text.trim() === '') {
          throw new Error(`Invalid localized release notes for locale '${locale}' (expected a non-empty string)`)
        }
        normalizedLocalizedNotes[locale] = text.trim()
      }
    }
  }

  const manifest = {
    version,
    releaseDate,
    url: `https://github.com/${FORK_REPOSITORY}/releases/download/v${version}/${expectedName}`,
    sha512: createHash('sha512').update(installerBytes).digest('base64'),
    notes: notes.trim(),
  }
  // Emit the field only when translations exist, so manifests for English-only
  // releases stay byte-identical to the pre-localization contract.
  if (normalizedLocalizedNotes !== null) {
    manifest.notesLocalized = normalizedLocalizedNotes
  }
  // Measure exactly what main() writes: pretty-printed JSON plus a trailing newline.
  const manifestBytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  if (manifestBytes > MAX_MANIFEST_BYTES) {
    throw new Error(`Manifest is ${manifestBytes} bytes (limit ${MAX_MANIFEST_BYTES}): the release notes are too large`)
  }
  return manifest
}

const CLI_OPTIONS = new Set(['version', 'repository', 'installer', 'release-date', 'notes-file', 'localized-notes-file', 'output'])
/** Repeatable option: each use adds one <locale>=<file> entry. */
const REPEATABLE_OPTIONS = new Set(['localized-notes-file'])

function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument '${arg}'`)
    const key = arg.slice(2)
    if (!CLI_OPTIONS.has(key)) throw new Error(`Unknown option '${arg}'`)
    if (options[key] !== undefined && !REPEATABLE_OPTIONS.has(key)) throw new Error(`Duplicate option '${arg}'`)
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for '${arg}'`)
    if (REPEATABLE_OPTIONS.has(key)) {
      const separator = value.indexOf('=')
      if (separator <= 0 || separator === value.length - 1) {
        throw new Error(`Invalid ${arg} value '${value}' (expected <locale>=<path>)`)
      }
      options[key] = [...(options[key] ?? []), [value.slice(0, separator), value.slice(separator + 1)]]
    } else {
      options[key] = value
    }
    i += 1
  }
  return options
}

function readLocalizedNotes(entries) {
  if (entries === undefined || entries.length === 0) return undefined
  const localizedNotes = {}
  for (const [locale, path] of entries) {
    if (Object.prototype.hasOwnProperty.call(localizedNotes, locale)) {
      throw new Error(`Duplicate localized notes for locale '${locale}'`)
    }
    localizedNotes[locale] = readFileSync(path, 'utf8')
  }
  return localizedNotes
}

function main(args) {
  const options = parseArgs(args)
  const required = ['version', 'repository', 'installer', 'release-date', 'notes-file', 'output']
  for (const key of required) {
    if (!options[key]) throw new Error(`Missing required option --${key}`)
  }

  const installerBytes = readFileSync(options.installer)
  const notes = readFileSync(options['notes-file'], 'utf8')
  const manifest = buildUpdateManifest({
    version: options.version,
    repository: options.repository,
    installerName: options.installer.replace(/^.*[\\/]/, ''),
    installerBytes,
    releaseDate: options['release-date'],
    notes,
    localizedNotes: readLocalizedNotes(options['localized-notes-file']),
  })

  writeFileSync(options.output, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${options.output} for v${manifest.version} (${manifest.sha512})`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    main(argv.slice(2))
  } catch (error) {
    console.error(`generate-update-manifest: ${error.message}`)
    process.exitCode = 1
  }
}

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
// Canonical UTC ISO timestamp, exactly what Date.prototype.toISOString() emits.
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

export function installerNameForVersion(version) {
  return `SayIt_${version}_x64-setup.exe`
}

export function buildUpdateManifest({ version, repository, installerName, installerBytes, releaseDate }) {
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

  return {
    version,
    releaseDate,
    url: `https://github.com/${FORK_REPOSITORY}/releases/download/v${version}/${expectedName}`,
    sha512: createHash('sha512').update(installerBytes).digest('base64'),
  }
}

const CLI_OPTIONS = new Set(['version', 'repository', 'installer', 'release-date', 'output'])

function parseArgs(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument '${arg}'`)
    const key = arg.slice(2)
    if (!CLI_OPTIONS.has(key)) throw new Error(`Unknown option '${arg}'`)
    if (options[key] !== undefined) throw new Error(`Duplicate option '${arg}'`)
    const value = args[i + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for '${arg}'`)
    options[key] = value
    i += 1
  }
  return options
}

function main(args) {
  const options = parseArgs(args)
  const required = ['version', 'repository', 'installer', 'release-date', 'output']
  for (const key of required) {
    if (!options[key]) throw new Error(`Missing required option --${key}`)
  }

  const installerBytes = readFileSync(options.installer)
  const manifest = buildUpdateManifest({
    version: options.version,
    repository: options.repository,
    installerName: options.installer.replace(/^.*[\\/]/, ''),
    installerBytes,
    releaseDate: options['release-date'],
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

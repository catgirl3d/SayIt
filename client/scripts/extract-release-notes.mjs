#!/usr/bin/env node
/**
 * Release guard and generator: extracts the CHANGELOG.md section for the
 * version being released.
 *
 * The GitHub release notes body is the changelog section of exactly the
 * released version — the delta since the previous release — followed by a link
 * to the full fork changelog pinned to the build commit. Extraction fails when
 * the section is missing or empty, so a build can never be published without
 * release notes that describe it.
 *
 * Version headings are exactly `## vX.Y.Z` (second level); a section runs until
 * the next version heading or the end of the file. A heading suffix such as
 * `(unreleased)` or a release date lives in the file but is normalized away in
 * the output, so the published heading is always the plain version.
 *
 * The same extractor serves the Ukrainian CHANGELOG.uk.md via --changelog:
 * the format is identical, and error messages name the actual source file.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { argv } from 'node:process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
// Exact numeric major.minor.patch, same rule as the client and the release workflow.
const NUMERIC_VERSION = /^\d+\.\d+\.\d+$/
// Exactly two leading hashes: deeper headings like `#### v0.2.2 notes` are not version
// sections. The version must end the token (whitespace or end of line), so malformed
// headings like `## v0.2.2.1` or `## v0.2.2-rc1` cannot be published as version 0.2.2.
const VERSION_HEADING = /^## v(\d+\.\d+\.\d+)(?=\s|$)/

export function extractReleaseNotes(changelogText, version, sourceName = 'CHANGELOG.md') {
  if (typeof version !== 'string' || !NUMERIC_VERSION.test(version)) {
    throw new Error(`Invalid release version '${version}' (expected numeric major.minor.patch)`)
  }

  const lines = changelogText.split(/\r?\n/)
  let start = -1
  let end = lines.length
  for (let i = 0; i < lines.length; i += 1) {
    const match = VERSION_HEADING.exec(lines[i])
    if (match === null) continue
    if (start >= 0) {
      end = i
      break
    }
    if (match[1] === version) start = i
  }

  if (start < 0) {
    throw new Error(`${sourceName} has no section for version ${version} (expected a '## v${version}' heading)`)
  }

  const body = lines.slice(start + 1, end).join('\n').trim()
  if (body === '') {
    throw new Error(`${sourceName} section for version ${version} is empty`)
  }

  return `## v${version}\n\n${body}`
}

const CLI_OPTIONS = new Set(['version', 'changelog', 'output'])

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
  if (!options.version) throw new Error('Missing required option --version')

  const changelogPath = options.changelog ?? join(REPO_ROOT, 'CHANGELOG.md')
  const sourceName = changelogPath.replace(/^.*[\\/]/, '')
  const section = extractReleaseNotes(readFileSync(changelogPath, 'utf8'), options.version, sourceName)

  if (options.output === undefined) {
    process.stdout.write(`${section}\n`)
    return
  }
  writeFileSync(options.output, `${section}\n`, 'utf8')
  console.log(`Wrote the v${options.version} release notes section to ${options.output}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    main(argv.slice(2))
  } catch (error) {
    console.error(`extract-release-notes: ${error.message}`)
    process.exitCode = 1
  }
}

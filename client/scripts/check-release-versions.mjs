#!/usr/bin/env node
/**
 * Release guard: every application version source must agree on one exact numeric
 * major.minor.patch value before a release is built.
 *
 * Sources checked:
 *   - client/package.json
 *   - client/package-lock.json (top-level `version` and the root package entry)
 *   - client/src-tauri/tauri.conf.json
 *   - client/src-tauri/Cargo.toml (through `cargo metadata --no-deps`, so the value
 *     the release build actually compiles with is what gets compared)
 *
 * The lockfile entry is the one that historically drifted (0.1.8 vs 0.1.9), and a
 * drifted lockfile is exactly how an installer ends up carrying a version the update
 * manifest does not describe. Run this locally before releasing and in the workflow
 * before building.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CLIENT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NUMERIC_VERSION = /^\d+\.\d+\.\d+$/

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(CLIENT_ROOT, relativePath), 'utf8'))
}

export function collectVersionSources() {
  const sources = []

  const packageJson = readJson('package.json')
  sources.push({ name: 'package.json', version: packageJson.version })

  const packageLock = readJson('package-lock.json')
  sources.push({ name: 'package-lock.json (version)', version: packageLock.version })
  sources.push({ name: 'package-lock.json (packages[""].version)', version: packageLock.packages?.['']?.version })

  const tauriConfig = readJson('src-tauri/tauri.conf.json')
  sources.push({ name: 'tauri.conf.json', version: tauriConfig.version })

  let metadataRaw
  try {
    metadataRaw = execFileSync(
      'cargo',
      ['metadata', '--manifest-path', join(CLIENT_ROOT, 'src-tauri/Cargo.toml'), '--no-deps', '--format-version', '1', '--offline'],
      { encoding: 'utf8' },
    )
  } catch (error) {
    throw new Error(`cargo metadata failed; a Rust toolchain with an up-to-date Cargo.lock is required: ${error.message}`)
  }
  const metadata = JSON.parse(metadataRaw)
  const rootPackage = metadata.packages.find((pkg) => pkg.name === 'sayit')
  sources.push({ name: 'Cargo.toml (cargo metadata)', version: rootPackage?.version })

  return sources
}

export function findVersionMismatches(sources) {
  const problems = []
  for (const source of sources) {
    if (typeof source.version !== 'string' || !NUMERIC_VERSION.test(source.version)) {
      problems.push(`${source.name}: '${source.version}' is not numeric major.minor.patch`)
    }
  }
  const distinct = [...new Set(sources.map((source) => source.version))]
  if (distinct.length > 1) {
    problems.push(`version sources disagree: ${sources.map((s) => `${s.name}=${s.version}`).join(', ')}`)
  }
  return problems
}

function main() {
  const sources = collectVersionSources()
  for (const source of sources) {
    console.log(`${source.name}: ${source.version}`)
  }
  const problems = findVersionMismatches(sources)
  if (problems.length > 0) {
    for (const problem of problems) {
      console.error(`check-release-versions: ${problem}`)
    }
    process.exitCode = 1
    return
  }
  console.log(`check-release-versions: all sources agree on ${sources[0].version}`)
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  try {
    main()
  } catch (error) {
    console.error(`check-release-versions: ${error.message}`)
    process.exitCode = 1
  }
}

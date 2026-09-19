import test from 'node:test'
import assert from 'node:assert/strict'
import { findVersionMismatches } from './check-release-versions.mjs'

const AGREEING = [
  { name: 'package.json', version: '0.2.1' },
  { name: 'package-lock.json (version)', version: '0.2.1' },
  { name: 'package-lock.json (packages[""].version)', version: '0.2.1' },
  { name: 'tauri.conf.json', version: '0.2.1' },
  { name: 'Cargo.toml (cargo metadata)', version: '0.2.1' },
]

test('accepts agreement across every version source', () => {
  assert.deepEqual(findVersionMismatches(AGREEING), [])
})

test('reports the drifted lockfile mismatch that actually happened', () => {
  const drifted = AGREEING.map((source) =>
    source.name.startsWith('package-lock') ? { ...source, version: '0.1.8' } : source,
  )
  const problems = findVersionMismatches(drifted)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /version sources disagree/)
  assert.match(problems[0], /package-lock\.json \(version\)=0\.1\.8/)
})

test('rejects non-numeric version formats', () => {
  for (const version of ['0.2.1-beta', '0.2', 'v0.2.1', undefined]) {
    const problems = findVersionMismatches([{ name: 'package.json', version }, { name: 'tauri.conf.json', version }])
    assert.ok(
      problems.some((problem) => problem.includes('not numeric major.minor.patch')),
      `'${version}' must be rejected`,
    )
  }
})

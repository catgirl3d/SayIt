import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractReleaseNotes } from './extract-release-notes.mjs'

const CHANGELOG = `# SayIt (Fork Changelog)

Intro text.

## v0.2.2 (unreleased)

### Features and Improvements

- New thing A.

## v0.2.1 — 2026-10-11

### Features and Improvements

- Old thing B.
`

test('extracts exactly the requested version section and normalizes the heading', () => {
  assert.equal(
    extractReleaseNotes(CHANGELOG, '0.2.2'),
    `## v0.2.2\n\n### Features and Improvements\n\n- New thing A.`,
  )
})

test('extracts an older section up to the end of the file', () => {
  assert.equal(
    extractReleaseNotes(CHANGELOG, '0.2.1'),
    `## v0.2.1\n\n### Features and Improvements\n\n- Old thing B.`,
  )
})

test('does not confuse a longer version heading with the requested one', () => {
  const text = '# c\n\n## v0.2.20\n\n- twenty\n\n## v0.2.2\n\n- two\n'
  assert.equal(extractReleaseNotes(text, '0.2.2'), '## v0.2.2\n\n- two')
})

test('ignores deeper headings that merely start with a version', () => {
  const text = '# c\n\n## v0.2.2\n\n#### v0.2.2 in-app notes\n\n- one\n'
  assert.equal(extractReleaseNotes(text, '0.2.2'), '## v0.2.2\n\n#### v0.2.2 in-app notes\n\n- one')
})

test('does not treat dotted or suffixed version headings as the requested version', () => {
  const text = '# c\n\n## v0.2.2.1\n\n- dotted\n\n## v0.2.2-rc1\n\n- rc\n'
  assert.throws(() => extractReleaseNotes(text, '0.2.2'), /no section for version 0\.2\.2/)
})

test('handles CRLF line endings', () => {
  const text = '# c\r\n\r\n## v0.2.2 (unreleased)\r\n\r\n- one\r\n'
  assert.equal(extractReleaseNotes(text, '0.2.2'), '## v0.2.2\n\n- one')
})

test('rejects a version with no section', () => {
  assert.throws(() => extractReleaseNotes(CHANGELOG, '0.2.3'), /no section for version 0\.2\.3/)
})

test('rejects an empty section', () => {
  const text = '# c\n\n## v0.2.2 (unreleased)\n\n## v0.2.1\n\n- old\n'
  assert.throws(() => extractReleaseNotes(text, '0.2.2'), /section for version 0\.2\.2 is empty/)
})

test('rejects a malformed version', () => {
  assert.throws(() => extractReleaseNotes(CHANGELOG, 'v0.2.2'), /Invalid release version/)
})

test('CLI writes the section to --output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sayit-notes-test-'))
  try {
    const changelogPath = join(dir, 'CHANGELOG-FORK.md')
    const outputPath = join(dir, 'notes.md')
    writeFileSync(changelogPath, CHANGELOG)

    const stdout = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./extract-release-notes.mjs', import.meta.url)),
        '--version', '0.2.2',
        '--changelog', changelogPath,
        '--output', outputPath,
      ],
      { encoding: 'utf8' },
    )
    assert.match(stdout, /Wrote the v0\.2\.2 release notes section/)
    assert.equal(
      readFileSync(outputPath, 'utf8'),
      `## v0.2.2\n\n### Features and Improvements\n\n- New thing A.\n`,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI fails closed when the section is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sayit-notes-test-'))
  try {
    const changelogPath = join(dir, 'CHANGELOG-FORK.md')
    writeFileSync(changelogPath, CHANGELOG)
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('./extract-release-notes.mjs', import.meta.url)),
          '--version', '0.2.9',
          '--changelog', changelogPath,
          '--output', join(dir, 'notes.md'),
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
      /no section for version 0\.2\.9/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

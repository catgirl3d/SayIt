import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildUpdateManifest } from './generate-update-manifest.mjs'

const VALID = {
  version: '0.2.1',
  repository: 'catgirl3d/SayIt',
  installerName: 'SayIt_0.2.1_x64-setup.exe',
  installerBytes: Buffer.from('fixture'),
  releaseDate: '2026-09-16T00:00:00.000Z',
}

test('builds the exact manifest contract', () => {
  assert.deepEqual(buildUpdateManifest(VALID), {
    version: '0.2.1',
    releaseDate: '2026-09-16T00:00:00.000Z',
    url: 'https://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe',
    sha512: createHash('sha512').update('fixture').digest('base64'),
  })
})

test('emits the exact canonical Base64 shape the client accepts', () => {
  const { sha512 } = buildUpdateManifest({ ...VALID, installerBytes: Buffer.from('x'.repeat(64)) })
  assert.match(sha512, /^[A-Za-z0-9+/]{86}==$/)
  assert.equal(Buffer.from(sha512, 'base64').length, 64)
})

test('rejects a repository other than the fork', () => {
  assert.throws(
    () => buildUpdateManifest({ ...VALID, repository: 'crosswk/SayIt' }),
    /Refusing to build a manifest for repository/,
  )
})

test('rejects a malformed version', () => {
  for (const version of ['0.2', '0.2.1-beta', 'v0.2.1', 'latest']) {
    assert.throws(
      () => buildUpdateManifest({ ...VALID, version }),
      /Invalid release version/,
      `version '${version}' must be rejected`,
    )
  }
})

test('rejects an installer name that does not match the version', () => {
  for (const installerName of [
    'SayIt_0.2.2_x64-setup.exe',
    'SayIt_0.2.1_x86-setup.exe',
    'SayItSetup.exe',
  ]) {
    assert.throws(
      () => buildUpdateManifest({ ...VALID, installerName }),
      /does not match the release version/,
      `installer '${installerName}' must be rejected`,
    )
  }
})

test('rejects a non-canonical release timestamp', () => {
  for (const releaseDate of [
    '2026-09-16',
    '2026-09-16T00:00:00Z',
    '2026-09-16T00:00:00.000+03:00',
    'not-a-date',
  ]) {
    assert.throws(
      () => buildUpdateManifest({ ...VALID, releaseDate }),
      /Invalid release date/,
      `timestamp '${releaseDate}' must be rejected`,
    )
  }
})

test('rejects non-buffer installer bytes', () => {
  for (const installerBytes of ['not-bytes', new Uint8Array([1, 2, 3])]) {
    assert.throws(
      () => buildUpdateManifest({ ...VALID, installerBytes }),
      /installerBytes must be a Buffer/,
    )
  }
})

test('CLI writes the manifest with a trailing newline', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sayit-manifest-test-'))
  try {
    const installerPath = join(dir, 'SayIt_0.2.1_x64-setup.exe')
    const outputPath = join(dir, 'latest-win32-x64.json')
    writeFileSync(installerPath, 'installer-bytes')

    const stdout = execFileSync(
      process.execPath,
      [
        fileURLToPath(new URL('./generate-update-manifest.mjs', import.meta.url)),
        '--version', '0.2.1',
        '--repository', 'catgirl3d/SayIt',
        '--installer', installerPath,
        '--release-date', '2026-09-19T00:00:00.000Z',
        '--output', outputPath,
      ],
      { encoding: 'utf8' },
    )
    assert.match(stdout, /Wrote .*latest-win32-x64\.json/)

    const raw = readFileSync(outputPath, 'utf8')
    assert.ok(raw.endsWith('\n'), 'manifest file must end with a newline')
    assert.deepEqual(JSON.parse(raw), {
      version: '0.2.1',
      releaseDate: '2026-09-19T00:00:00.000Z',
      url: 'https://github.com/catgirl3d/SayIt/releases/download/v0.2.1/SayIt_0.2.1_x64-setup.exe',
      sha512: createHash('sha512').update('installer-bytes').digest('base64'),
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('CLI fails closed on a foreign repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sayit-manifest-test-'))
  try {
    const installerPath = join(dir, 'SayIt_0.2.1_x64-setup.exe')
    writeFileSync(installerPath, 'installer-bytes')
    assert.throws(
      () => execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL('./generate-update-manifest.mjs', import.meta.url)),
          '--version', '0.2.1',
          '--repository', 'crosswk/SayIt',
          '--installer', installerPath,
          '--release-date', '2026-09-19T00:00:00.000Z',
          '--output', join(dir, 'latest-win32-x64.json'),
        ],
        { encoding: 'utf8', stdio: 'pipe' },
      ),
      /Refusing to build a manifest for repository/,
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

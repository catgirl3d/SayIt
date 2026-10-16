import assert from 'node:assert/strict'
import { execFile as execFileCallback } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import {
  canonicalizeArchivePath,
  downloadArchive,
  extractFiles,
  installFiles,
  MAX_ARCHIVE_BYTES,
  validateLock,
  verifyExtractedFiles,
} from './fetch-sidecar.mjs'

const execFile = promisify(execFileCallback)

function sha256(contents) {
  return createHash('sha256').update(contents).digest('hex')
}

function validLock() {
  return {
    archiveUrl: 'https://example.test/ffmpeg.tar.gz',
    archiveSha256: 'a'.repeat(64),
    files: [
      {
        name: 'ffmpeg.exe',
        pathInArchive: 'package/bin/ffmpeg.exe',
        sha256: 'b'.repeat(64),
      },
      {
        name: 'ffprobe.exe',
        pathInArchive: 'package/bin/ffprobe.exe',
        sha256: 'c'.repeat(64),
      },
    ],
  }
}

test('validates required lock fields and hashes', () => {
  assert.throws(() => validateLock({}), /archiveUrl is required/)

  const invalidArchiveHash = validLock()
  invalidArchiveHash.archiveSha256 = 'broken'
  assert.throws(() => validateLock(invalidArchiveHash), /archiveSha256 must be a 64-character SHA-256 value/)

  const missingFiles = validLock()
  delete missingFiles.files
  assert.throws(() => validateLock(missingFiles), /exactly ffmpeg\.exe and ffprobe\.exe must be listed/)

  const oneFile = validLock()
  oneFile.files = oneFile.files.slice(0, 1)
  assert.throws(() => validateLock(oneFile), /exactly ffmpeg\.exe and ffprobe\.exe must be listed/)

  const threeFiles = validLock()
  threeFiles.files = [...threeFiles.files, { ...threeFiles.files[0], name: 'other.exe' }]
  assert.throws(() => validateLock(threeFiles), /exactly ffmpeg\.exe and ffprobe\.exe must be listed/)

  const missingArchivePath = validLock()
  delete missingArchivePath.files[0].pathInArchive
  assert.throws(() => validateLock(missingArchivePath), /unsafe archive path for ffmpeg\.exe/)

  const invalidFileHash = validLock()
  invalidFileHash.files[0].sha256 = 'broken'
  assert.throws(() => validateLock(invalidFileHash), /sha256 must be a 64-character SHA-256 value for ffmpeg\.exe/)

  const mixedCaseHashes = validLock()
  mixedCaseHashes.archiveSha256 = 'A'.repeat(64)
  mixedCaseHashes.files[0].sha256 = 'B'.repeat(64)
  mixedCaseHashes.files[1].sha256 = 'C'.repeat(64)
  assert.doesNotThrow(() => validateLock(mixedCaseHashes))

  const duplicateName = validLock()
  duplicateName.files[1].name = 'ffmpeg.exe'
  assert.throws(() => validateLock(duplicateName), /exactly one ffmpeg\.exe and one ffprobe\.exe/)
})

test('canonicalizes archive paths and rejects unsafe forms', () => {
  assert.equal(canonicalizeArchivePath('.\\package\\bin//ffmpeg.exe'), 'package/bin/ffmpeg.exe')
  assert.equal(canonicalizeArchivePath('package/./bin/ffmpeg.exe'), 'package/bin/ffmpeg.exe')

  for (const pathInArchive of ['', '.', '../ffmpeg.exe', 'package/../ffmpeg.exe', '/ffmpeg.exe', 'C:\\ffmpeg.exe']) {
    assert.throws(() => canonicalizeArchivePath(pathInArchive), /parent traversal|absolute|empty/i)
  }

  const duplicatePath = validLock()
  duplicatePath.files[1].pathInArchive = './package//bin/ffmpeg.exe'
  assert.throws(() => validateLock(duplicatePath), /duplicate archive path/)

  const nulPath = validLock()
  nulPath.files[0].pathInArchive = 'package/bin/ffmpeg\0.exe'
  assert.throws(() => validateLock(nulPath), /NUL bytes/)
})

test('cancels a download before buffering content beyond the size limit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sayit-sidecar-test-'))
  const archivePath = join(root, 'ffmpeg.tar.gz')
  const originalFetch = globalThis.fetch
  let cancelled = false
  globalThis.fetch = async () => ({
    ok: true,
    body: {
      getReader() {
        return {
          async read() {
            return { done: false, value: { byteLength: MAX_ARCHIVE_BYTES + 1 } }
          },
          async cancel() {
            cancelled = true
          },
          releaseLock() {},
        }
      },
    },
    headers: { get: () => null },
  })

  try {
    await assert.rejects(
      () => downloadArchive('https://example.test/ffmpeg.tar.gz', archivePath),
      /downloaded content exceeds the 67108864-byte size limit/,
    )
    assert.equal(cancelled, true)
  } finally {
    globalThis.fetch = originalFetch
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects a directory where an extracted file is expected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sayit-sidecar-test-'))
  try {
    const extractDir = join(root, 'extract')
    const fileDirectory = join(extractDir, 'package', 'bin', 'ffmpeg.exe')
    const files = validLock().files
    await mkdir(fileDirectory, { recursive: true })
    await mkdir(join(extractDir, 'package', 'bin'), { recursive: true })
    await writeFile(join(extractDir, 'package', 'bin', 'ffprobe.exe'), 'ffprobe')

    await assert.rejects(
      () => verifyExtractedFiles(extractDir, files),
      /Expected ffmpeg\.exe in FFmpeg archive to be a regular file/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extracts, verifies, and installs a synthetic local archive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sayit-sidecar-test-'))
  try {
    const sourceDir = join(root, 'package', 'bin')
    const archivePath = join(root, 'ffmpeg.tar.gz')
    const extractDir = join(root, 'extract')
    const targetDir = join(root, 'target')
    const ffmpegContents = 'synthetic ffmpeg'
    const ffprobeContents = 'synthetic ffprobe'
    const files = [
      {
        name: 'ffmpeg.exe',
        pathInArchive: 'package/bin/ffmpeg.exe',
        sha256: sha256(ffmpegContents),
      },
      {
        name: 'ffprobe.exe',
        pathInArchive: 'package/bin/ffprobe.exe',
        sha256: sha256(ffprobeContents),
      },
    ]

    await mkdir(sourceDir, { recursive: true })
    await mkdir(extractDir)
    await writeFile(join(sourceDir, 'ffmpeg.exe'), ffmpegContents)
    await writeFile(join(sourceDir, 'ffprobe.exe'), ffprobeContents)
    await execFile('tar', ['-czf', 'ffmpeg.tar.gz', 'package/bin/ffmpeg.exe', 'package/bin/ffprobe.exe'], {
      cwd: root,
      windowsHide: true,
    })

    await extractFiles(archivePath, extractDir, files)
    await verifyExtractedFiles(extractDir, files)
    await installFiles(extractDir, files, targetDir)

    assert.equal(await readFile(join(targetDir, 'ffmpeg.exe'), 'utf8'), ffmpegContents)
    assert.equal(await readFile(join(targetDir, 'ffprobe.exe'), 'utf8'), ffprobeContents)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

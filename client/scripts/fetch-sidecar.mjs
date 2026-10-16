#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFile as execFileCallback } from 'node:child_process'
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LOCK_PATH = join(CLIENT_ROOT, 'ffmpeg.lock.json')
const RESOURCE_DIR = join(CLIENT_ROOT, 'src-tauri', 'resources', 'ffmpeg')
const EXPECTED_FILE_NAMES = new Set(['ffmpeg.exe', 'ffprobe.exe'])
export const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 120000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function canonicalizeArchivePath(pathInArchive) {
  if (typeof pathInArchive !== 'string' || pathInArchive.length === 0) {
    throw new Error('Invalid archive path: pathInArchive must be a non-empty string')
  }
  const posixPath = pathInArchive.replaceAll('\\', '/')
  if (posixPath.includes('\0')) {
    throw new Error('Invalid archive path: NUL bytes are not allowed')
  }
  if (posixPath.startsWith('/') || /^[a-zA-Z]:/.test(posixPath)) {
    throw new Error(`Invalid archive path: absolute path is not allowed: ${pathInArchive}`)
  }
  const parts = posixPath.split('/')
  if (parts.includes('..')) {
    throw new Error(`Invalid archive path: parent traversal is not allowed: ${pathInArchive}`)
  }
  const canonicalPath = parts.filter((part) => part !== '' && part !== '.').join('/')
  if (canonicalPath.length === 0) {
    throw new Error(`Invalid archive path: path is empty after normalization: ${pathInArchive}`)
  }
  return canonicalPath
}

export function validateLock(lock) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new Error('Invalid lock file: an object is required')
  }
  if (typeof lock.archiveUrl !== 'string' || lock.archiveUrl.length === 0) {
    throw new Error('Invalid lock file: archiveUrl is required')
  }
  if (!/^[a-f0-9]{64}$/i.test(lock.archiveSha256 ?? '')) {
    throw new Error('Invalid lock file: archiveSha256 must be a 64-character SHA-256 value')
  }
  if (!Array.isArray(lock.files) || lock.files.length !== EXPECTED_FILE_NAMES.size) {
    throw new Error('Invalid lock file: exactly ffmpeg.exe and ffprobe.exe must be listed')
  }

  const names = new Set()
  const archivePaths = new Set()
  const files = []
  for (const file of lock.files) {
    if (!file || typeof file !== 'object' || !EXPECTED_FILE_NAMES.has(file.name) || names.has(file.name)) {
      throw new Error('Invalid lock file: exactly one ffmpeg.exe and one ffprobe.exe must be listed')
    }
    let canonicalPath
    try {
      canonicalPath = canonicalizeArchivePath(file.pathInArchive)
    } catch (error) {
      throw new Error(`Invalid lock file: unsafe archive path for ${file.name}: ${errorMessage(error)}`)
    }
    if (archivePaths.has(canonicalPath)) {
      throw new Error(`Invalid lock file: duplicate archive path after normalization: ${canonicalPath}`)
    }
    if (!/^[a-f0-9]{64}$/i.test(file.sha256 ?? '')) {
      throw new Error(`Invalid lock file: sha256 must be a 64-character SHA-256 value for ${file.name}`)
    }
    names.add(file.name)
    archivePaths.add(canonicalPath)
    files.push({ ...file, pathInArchive: canonicalPath })
  }

  return { ...lock, files }
}

export async function readLock() {
  let lock
  try {
    lock = JSON.parse(await readFile(LOCK_PATH, 'utf8'))
  } catch (error) {
    throw new Error(`Cannot read ${LOCK_PATH}: ${errorMessage(error)}`)
  }
  return validateLock(lock)
}

async function sha256File(filePath) {
  const contents = await readFile(filePath)
  return createHash('sha256').update(contents).digest('hex')
}

async function existingHashes(files) {
  const hashes = []
  for (const file of files) {
    try {
      hashes.push(await sha256File(join(RESOURCE_DIR, file.name)))
    } catch (error) {
      if (error?.code === 'ENOENT') return null
      throw new Error(`Cannot verify existing ${file.name}: ${errorMessage(error)}`)
    }
  }
  return hashes
}

function assertArchiveSize(size, source) {
  if (size > MAX_ARCHIVE_BYTES) {
    throw new Error(`FFmpeg archive ${source} exceeds the ${MAX_ARCHIVE_BYTES}-byte size limit`)
  }
}

function parseContentLength(value) {
  if (value === null) return null
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`FFmpeg archive has an invalid content-length: ${value}`)
  }
  return size
}

export async function downloadArchive(url, archivePath) {
  let response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (error) {
    throw new Error(`Failed to download FFmpeg archive: ${errorMessage(error)}`)
  }
  if (!response.ok) {
    throw new Error(`Failed to download FFmpeg archive: HTTP ${response.status} ${response.statusText}`)
  }
  if (!response.body) {
    throw new Error('Failed to download FFmpeg archive: response body is empty')
  }

  const contentLength = parseContentLength(response.headers.get('content-length'))
  if (contentLength !== null) {
    if (contentLength > MAX_ARCHIVE_BYTES) {
      try {
        await response.body.cancel()
      } catch {
        // Preserve the content-length error if cancellation itself fails.
      }
    }
    assertArchiveSize(contentLength, 'content-length')
  }

  let archiveContents
  const reader = response.body.getReader()
  const chunks = []
  let totalSize = 0
  let sizeLimitExceeded = false
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      const chunkSize = value.byteLength
      if (totalSize + chunkSize > MAX_ARCHIVE_BYTES) {
        sizeLimitExceeded = true
        chunks.length = 0
        try {
          await reader.cancel()
        } catch {
          // Preserve the size-limit error if cancellation itself fails.
        }
        throw new Error(`FFmpeg archive downloaded content exceeds the ${MAX_ARCHIVE_BYTES}-byte size limit`)
      }
      const chunk = Buffer.from(value)
      totalSize += chunk.length
      chunks.push(chunk)
    }
    archiveContents = Buffer.concat(chunks, totalSize)
  } catch (error) {
    chunks.length = 0
    if (sizeLimitExceeded) throw error
    throw new Error(`Failed to download FFmpeg archive: ${errorMessage(error)}`)
  } finally {
    reader.releaseLock()
  }
  assertArchiveSize(archiveContents.length, 'downloaded content')

  try {
    await writeFile(archivePath, archiveContents)
  } catch (error) {
    throw new Error(`Failed to save FFmpeg archive: ${errorMessage(error)}`)
  }
}

export function extractedPath(extractDir, pathInArchive, fileName) {
  const canonicalPath = canonicalizeArchivePath(pathInArchive)
  if (canonicalPath !== pathInArchive) {
    throw new Error(`Archive path for ${fileName} is not canonical: ${pathInArchive}`)
  }
  const candidate = resolve(extractDir, ...canonicalPath.split('/'))
  const relativePath = relative(extractDir, candidate)
  if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Unsafe archive path for ${fileName}`)
  }
  return candidate
}

export async function extractFiles(archivePath, extractDir, files) {
  const archivePaths = files.map((file) => {
    extractedPath(extractDir, file.pathInArchive, file.name)
    return file.pathInArchive
  })
  const stagingDir = dirname(archivePath)
  const archiveRelativePath = relative(stagingDir, archivePath)
  const extractRelativePath = relative(stagingDir, extractDir)

  try {
    await execFile('tar', ['-xzf', archiveRelativePath, '-C', extractRelativePath, '--', ...archivePaths], {
      cwd: stagingDir,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    })
  } catch (error) {
    const details = error?.stderr?.trim() || errorMessage(error)
    throw new Error(`Failed to extract FFmpeg archive: ${details}`)
  }
}

export async function verifyExtractedFiles(extractDir, files) {
  for (const file of files) {
    const filePath = extractedPath(extractDir, file.pathInArchive, file.name)
    let fileStats
    try {
      fileStats = await stat(filePath)
    } catch (error) {
      throw new Error(`Missing ${file.name} in FFmpeg archive: ${errorMessage(error)}`)
    }
    if (!fileStats.isFile()) {
      throw new Error(`Expected ${file.name} in FFmpeg archive to be a regular file`)
    }

    const actualHash = await sha256File(filePath)
    if (actualHash !== file.sha256.toLowerCase()) {
      throw new Error(`SHA-256 mismatch for ${file.name}: expected ${file.sha256}, got ${actualHash}`)
    }
  }
}

export async function installFiles(extractDir, files, targetDir = RESOURCE_DIR) {
  try {
    await mkdir(targetDir, { recursive: true })
  } catch (error) {
    throw new Error(`Cannot prepare the FFmpeg resource directory ${targetDir}: ${errorMessage(error)}`)
  }
  for (const file of files) {
    const sourcePath = extractedPath(extractDir, file.pathInArchive, file.name)
    const targetPath = join(targetDir, file.name)
    try {
      await copyFile(sourcePath, targetPath)
    } catch (error) {
      throw new Error(`Failed to install ${file.name}: ${errorMessage(error)}`)
    }
  }
}

async function main() {
  const lock = await readLock()
  const currentHashes = await existingHashes(lock.files)
  if (currentHashes && currentHashes.every((hash, index) => hash === lock.files[index].sha256.toLowerCase())) {
    console.log('fetch-sidecar: already present and verified')
    return
  }

  console.log('fetch-sidecar: existing sidecar is missing or does not match the lock; downloading pinned archive')
  const stagingDir = await mkdtemp(join(tmpdir(), 'sayit-ffmpeg-'))
  let operationError
  let cleanupError
  try {
    const archivePath = join(stagingDir, 'ffmpeg.tar.gz')
    const extractDir = join(stagingDir, 'extract')
    await mkdir(extractDir)

    await downloadArchive(lock.archiveUrl, archivePath)
    const archiveHash = await sha256File(archivePath)
    if (archiveHash !== lock.archiveSha256.toLowerCase()) {
      throw new Error(`FFmpeg archive SHA-256 mismatch: expected ${lock.archiveSha256}, got ${archiveHash}`)
    }

    await extractFiles(archivePath, extractDir, lock.files)
    await verifyExtractedFiles(extractDir, lock.files)
    await installFiles(extractDir, lock.files)
  } catch (error) {
    operationError = error
  } finally {
    try {
      await rm(stagingDir, { recursive: true, force: true })
    } catch (error) {
      cleanupError = error
    }
  }

  if (operationError) {
    if (cleanupError) {
      throw new Error(`${errorMessage(operationError)}; staging cleanup failed: ${errorMessage(cleanupError)}`)
    }
    throw operationError
  }
  if (cleanupError) {
    console.warn(`fetch-sidecar: staging cleanup failed: ${errorMessage(cleanupError)}`)
  }
  console.log('fetch-sidecar: installed ffmpeg.exe and ffprobe.exe; archive and file hashes verified')
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error(`fetch-sidecar: ${errorMessage(error)}`)
    process.exit(1)
  })
}

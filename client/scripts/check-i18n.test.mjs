import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const scriptPath = fileURLToPath(new URL('./check-i18n.mjs', import.meta.url))
const clientNodeModules = fileURLToPath(new URL('../node_modules', import.meta.url))

const fixtureRoots = []

after(() => {
  for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true })
})

/** Build a throwaway client tree: the real script plus locale/code fixtures the checker will scan. */
function makeFixture({ en, uk, codeFiles = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'check-i18n-'))
  fixtureRoots.push(root)
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'src/i18n/locales'), { recursive: true })
  copyFileSync(scriptPath, join(root, 'scripts/check-i18n.mjs'))
  writeFileSync(join(root, 'src/i18n/locales/en.json'), JSON.stringify(en, null, 2))
  writeFileSync(join(root, 'src/i18n/locales/uk.json'), JSON.stringify(uk, null, 2))
  for (const [relPath, text] of Object.entries(codeFiles)) {
    const full = join(root, 'src', relPath)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
  }
  symlinkSync(clientNodeModules, join(root, 'node_modules'), 'junction')
  return root
}

function runChecker(root, args = []) {
  return spawnSync(process.execPath, ['scripts/check-i18n.mjs', ...args], { cwd: root, encoding: 'utf8' })
}

test('fails strict check on placeholder mismatch between en and uk', () => {
  const root = makeFixture({
    en: { 'home.title': 'Hello {name}', 'nav.home': 'Home' },
    uk: { 'home.title': 'Привіт {імʼя}', 'nav.home': 'Головна' },
  })
  const result = runChecker(root, ['--strict', '--all'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /placeholder mismatch: home\.title/)
})

test('detects Chinese inside nested locale values', () => {
  const root = makeFixture({
    en: { nested: { inner: ['ok', { deep: 'Fine' }] } },
    uk: { nested: { inner: ['ок', { deep: '中文' }] } },
  })
  const result = runChecker(root, ['--strict', '--all'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /nested\.inner\[1\]\.deep/)
})

test('fails strict check on a key missing from uk', () => {
  const root = makeFixture({
    en: { section: { a: 'A', b: 'B' } },
    uk: { section: { a: 'А' } },
  })
  const result = runChecker(root, ['--strict', '--all'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /missing in uk\.json: section\.b/)
})

test('fails strict check on a key that exists only in uk', () => {
  const root = makeFixture({
    en: { section: { a: 'A' } },
    uk: { section: { a: 'А', orphan: 'B' } },
  })
  const result = runChecker(root, ['--strict', '--all'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /missing in en\.json: section\.orphan/)
})

test('fails strict check on hardcoded Chinese in code', () => {
  const root = makeFixture({
    en: { 'plain.key': 'Value' },
    uk: { 'plain.key': 'Значення' },
    codeFiles: { 'App.tsx': 'export const label = "中文"\n' },
  })
  const result = runChecker(root, ['--strict', '--all'])
  assert.equal(result.status, 1)
  assert.match(result.stdout, /src\/App\.tsx/)
})

test('reports clean run on consistent locales and clean code', () => {
  const root = makeFixture({
    en: { 'plain.key': 'Value {count}' },
    uk: { 'plain.key': 'Значення {count}' },
  })
  const result = runChecker(root, ['--strict'])
  assert.equal(result.status, 0)
  assert.match(result.stdout, /no hardcoded Chinese outside the allowlist; en\/uk locales are consistent/)
})

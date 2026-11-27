#!/usr/bin/env node
// Regenerates the README screenshots (docs/images/readme/<screen>-<en|ua>.png) from the
// readme/Screens stories in src/storybook/ReadmeScreens.stories.tsx.
//
// Usage, from client/:
//   npm run screenshots:readme
//   npm run screenshots:readme -- --only home,history
//   npm run screenshots:readme -- --out ../temp/readme-shots
//   npm run screenshots:readme -- --storybook-url http://localhost:6006
//
// --only           Capture only these screens (comma-separated file stems, e.g. home,history).
// --out            Write the PNGs to this directory instead of docs/images/readme.
// --storybook-url  Use a Storybook that is already running instead of starting one.
// CHROME_PATH      Overrides the browser lookup; any Chromium browser with DevTools works.
//
// Capture on Windows: the app renders in WebView2 with Windows system fonts, so captures made on
// another system would not match what users see.
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, promisify } from 'node:util'

const execFile = promisify(execFileCallback)
const CLIENT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_OUT_DIR = resolve(CLIENT_ROOT, '..', 'docs', 'images', 'readme')

// The main window's default size from tauri.conf.json.
const WIDTH = 1120
const HEIGHT = 768
const THEME = 'dark'
const STORY_PREFIX = 'readme-screens--'

// `ready` names an element that appears only once the page's async data has rendered.
const SHOTS = [
  { file: 'home', story: 'home-screen', ready: 'main h1' },
  { file: 'voice-engine', story: 'voice-engine', ready: 'main h1' },
  { file: 'ai-processing', story: 'ai-processing', ready: 'main h1' },
  { file: 'ai-providers', story: 'ai-providers', ready: '[role="radiogroup"]' },
  { file: 'history', story: 'history-screen', ready: 'main h1' },
  { file: 'appearance', story: 'appearance', ready: 'main h1' },
]
// The README file suffix for Ukrainian is "ua"; the app locale code is "uk".
const LOCALES = [
  { code: 'en', suffix: 'en' },
  { code: 'uk', suffix: 'ua' },
]

const STORYBOOK_START_TIMEOUT_MS = 5 * 60_000
const STORY_READY_TIMEOUT_MS = 60_000
// After the ready element appears, settings reads and layout still need a moment to land.
const SETTLE_MS = 1_500

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))

function parseOptions() {
  const { values } = parseArgs({
    options: {
      only: { type: 'string' },
      out: { type: 'string' },
      'storybook-url': { type: 'string' },
    },
    strict: true,
  })
  let shots = SHOTS
  if (values.only) {
    const wanted = values.only.split(',').map((name) => name.trim()).filter(Boolean)
    const unknown = wanted.filter((name) => !SHOTS.some((shot) => shot.file === name))
    if (unknown.length > 0) {
      throw new Error(`Unknown screen(s) in --only: ${unknown.join(', ')}. Known: ${SHOTS.map((s) => s.file).join(', ')}`)
    }
    shots = SHOTS.filter((shot) => wanted.includes(shot.file))
  }
  return {
    shots,
    outDir: values.out ? resolve(process.cwd(), values.out) : DEFAULT_OUT_DIR,
    storybookUrl: values['storybook-url']?.replace(/\/+$/, ''),
  }
}

function findChrome() {
  if (process.env.CHROME_PATH) {
    if (!existsSync(process.env.CHROME_PATH)) throw new Error(`CHROME_PATH does not exist: ${process.env.CHROME_PATH}`)
    return process.env.CHROME_PATH
  }
  const windowsRoots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)
  const candidates = [
    ...windowsRoots.map((root) => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...windowsRoots.map((root) => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error('No Chrome or Edge found; set CHROME_PATH to a Chromium browser executable')
  return found
}

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolvePort(port))
    })
  })
}

// On Windows a child's own children (Vite workers, Chrome renderers) survive child.kill(),
// so the whole tree is ended with taskkill. Elsewhere the child leads its own process group.
async function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    await execFile('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch((error) => {
      // taskkill exits 128 when the process is already gone; anything else is a real failure.
      if (child.exitCode === null) console.warn(`Could not stop process ${child.pid}: ${error.message}`)
    })
    return
  }
  process.kill(-child.pid, 'SIGTERM')
}

async function startStorybook() {
  const require = createRequire(import.meta.url)
  const storybookBin = join(dirname(require.resolve('storybook/package.json')), 'dist', 'bin', 'dispatcher.js')
  const port = await freePort()
  const child = spawn(process.execPath, [storybookBin, 'dev', '-p', String(port), '--ci', '--no-open'], {
    cwd: CLIENT_ROOT,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })

  const url = `http://localhost:${port}`
  const deadline = Date.now() + STORYBOOK_START_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Storybook exited with code ${child.exitCode}:\n${output}`)
    const status = await fetch(`${url}/iframe.html`).then((response) => response.status, () => 0)
    if (status === 200) return { child, url }
    await sleep(500)
  }
  await killTree(child)
  throw new Error(`Storybook did not start within ${STORYBOOK_START_TIMEOUT_MS / 1000} s:\n${output}`)
}

async function assertStoriesExist(storybookUrl, shots) {
  const response = await fetch(`${storybookUrl}/index.json`)
  if (!response.ok) throw new Error(`Could not read the Storybook index: HTTP ${response.status}`)
  const { entries } = await response.json()
  const missing = shots.map((shot) => `${STORY_PREFIX}${shot.story}`).filter((id) => !entries[id])
  if (missing.length > 0) {
    throw new Error(`Stories missing from ReadmeScreens.stories.tsx: ${missing.join(', ')}`)
  }
}

async function launchChrome(chromePath, profileDir) {
  const child = spawn(chromePath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${WIDTH},${HEIGHT}`,
    '--force-device-scale-factor=1',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { detached: process.platform !== 'win32', stdio: 'ignore' })

  // With port 0 Chrome picks a free port and writes it to DevToolsActivePort in the profile.
  const portFile = join(profileDir, 'DevToolsActivePort')
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null) throw new Error(`${chromePath} exited with code ${child.exitCode}`)
    const port = await readFile(portFile, 'utf8').then((text) => text.split('\n')[0].trim(), () => '')
    if (port) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])
      const page = targets.find((target) => target.type === 'page')
      if (page) return { child, wsUrl: page.webSocketDebuggerUrl }
    }
    await sleep(200)
  }
  await killTree(child)
  throw new Error('Chrome did not open a DevTools page target')
}

async function connectCdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  await new Promise((resolveOpen, reject) => {
    ws.onopen = resolveOpen
    ws.onerror = () => reject(new Error(`Could not connect to Chrome DevTools at ${wsUrl}`))
  })
  let nextId = 1
  const pending = new Map()
  const pageErrors = []
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolveCall, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`))
      else resolveCall(message.result)
    } else if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageErrors.push(message.params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '))
    } else if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails
      pageErrors.push(details.exception?.description ?? details.text)
    }
  }
  const send = (method, params = {}) => {
    const id = nextId++
    ws.send(JSON.stringify({ id, method, params }))
    return new Promise((resolveCall, reject) => pending.set(id, { resolveCall, reject }))
  }
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text)
    return result.value
  }
  return { ws, send, evaluate, pageErrors }
}

async function captureShot(cdp, storybookUrl, shot, locale, outDir) {
  const name = `${shot.file}-${locale.suffix}`
  cdp.pageErrors.length = 0
  const url = `${storybookUrl}/iframe.html?id=${STORY_PREFIX}${shot.story}&viewMode=story&globals=theme:${THEME};locale:${locale.code}`
  await cdp.send('Page.navigate', { url })

  const readyExpression = `Boolean(document.querySelector(${JSON.stringify(`#storybook-root ${shot.ready}`)}))`
  const deadline = Date.now() + STORY_READY_TIMEOUT_MS
  let ready = false
  while (!ready && Date.now() < deadline) {
    await sleep(200)
    // The document is replaced during navigation; an evaluate in that window has no context yet.
    ready = await cdp.evaluate(readyExpression).catch(() => false)
  }
  if (!ready) throw new Error(`${name}: "${shot.ready}" did not appear within ${STORY_READY_TIMEOUT_MS / 1000} s`)

  await cdp.evaluate('document.fonts.ready.then(() => true)')
  await sleep(SETTLE_MS)

  // An unmocked command makes the page fall back to an error or empty state, which must not ship.
  const unknownCommands = await cdp.evaluate('window.__readmeJournal ? window.__readmeJournal().unknownCommands : null')
  if (unknownCommands === null) throw new Error(`${name}: the story did not expose its Tauri journal`)
  if (unknownCommands.length > 0) throw new Error(`${name}: unmocked Tauri commands: ${unknownCommands.join(', ')}`)
  if (cdp.pageErrors.length > 0) throw new Error(`${name}: the page reported errors:\n  ${cdp.pageErrors.join('\n  ')}`)

  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const file = join(outDir, `${name}.png`)
  await writeFile(file, Buffer.from(data, 'base64'))
  console.log(`  ${file}`)
}

async function main() {
  const options = parseOptions()
  const chromePath = findChrome()
  await mkdir(options.outDir, { recursive: true })

  let storybook
  let chrome
  let cdp
  const profileDir = await mkdtemp(join(tmpdir(), 'sayit-readme-chrome-'))
  const cleanup = async () => {
    cdp?.ws.close()
    await killTree(chrome?.child)
    await killTree(storybook?.child)
    // Chrome may hold profile files for a moment after it is killed.
    await rm(profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch((error) => {
      console.warn(`Could not remove the temporary Chrome profile ${profileDir}: ${error.message}`)
    })
  }
  process.once('SIGINT', () => {
    void cleanup().finally(() => process.exit(130))
  })

  try {
    if (options.storybookUrl) {
      console.log(`Using Storybook at ${options.storybookUrl}`)
    } else {
      console.log('Starting Storybook...')
      storybook = await startStorybook()
      console.log(`Storybook is up at ${storybook.url}`)
    }
    const storybookUrl = options.storybookUrl ?? storybook.url
    await assertStoriesExist(storybookUrl, options.shots)

    chrome = await launchChrome(chromePath, profileDir)
    cdp = await connectCdp(chrome.wsUrl)
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })

    console.log(`Capturing ${options.shots.length * LOCALES.length} screenshots into ${options.outDir}`)
    for (const shot of options.shots) {
      for (const locale of LOCALES) await captureShot(cdp, storybookUrl, shot, locale, options.outDir)
    }
  } finally {
    await cleanup()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})

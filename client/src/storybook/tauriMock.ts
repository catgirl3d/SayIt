import type { InvokeArgs } from '@tauri-apps/api/core'
import { clearMocks, mockIPC, mockWindows } from '@tauri-apps/api/mocks'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type TauriCommandHandler = (args: InvokeArgs | undefined) => unknown | Promise<unknown>

// Stories can stub WelcomeGuide/NoticeBanner with `parameters.network: { 'https://.../api/notice': () => new Response(...) }`.
// Keys are literal URL prefixes; matching handlers receive a Request and return a Response.
export type NetworkStub = (request: Request) => Response | Promise<Response>

export interface TauriParameters {
  commands?: Record<string, TauriCommandHandler>
  settings?: Record<string, JsonValue>
}

export interface TauriStoryContext {
  id?: string
  parameters?: Record<string, unknown> & {
    tauri?: TauriParameters
    network?: Record<string, NetworkStub>
  }
}

export interface TauriCall {
  command: string
  args: InvokeArgs | undefined
}

export interface TauriJournal {
  unknownCommands: string[]
  fetchViolations: string[]
  stubbedRequests: string[]
  calls: TauriCall[]
}

interface StorySession {
  id: string
  commands: Record<string, TauriCommandHandler>
  network: Record<string, NetworkStub>
  settings: Map<string, JsonValue>
  journal: TauriJournal
  closed: boolean
}

interface DrainingSession {
  session: StorySession
  baseline: {
    unknownCommands: number
    fetchViolations: number
    stubbedRequests: number
    calls: number
  }
}

const NO_ACTIVE_STORY_ID = '<no-active-story>'
let activeSession: StorySession | undefined
let drainingSession: DrainingSession | undefined
let completedJournal = createJournal()
let preStoryJournal = createJournal()
let orphanJournal = createJournal()
let hasStartedStory = false
let installedInvoke: unknown

function createJournal(): TauriJournal {
  return { unknownCommands: [], fetchViolations: [], stubbedRequests: [], calls: [] }
}

function snapshotJournal(journal: TauriJournal): TauriJournal {
  return {
    unknownCommands: [...journal.unknownCommands],
    fetchViolations: [...journal.fetchViolations],
    stubbedRequests: [...journal.stubbedRequests],
    calls: journal.calls.map((call) => ({ ...call })),
  }
}

function mergeJournal(target: TauriJournal, source: TauriJournal): void {
  target.unknownCommands.push(...source.unknownCommands)
  target.fetchViolations.push(...source.fetchViolations)
  target.stubbedRequests.push(...source.stubbedRequests)
  target.calls.push(...source.calls.map((call) => ({ ...call })))
}

function mergeJournalDelta(target: TauriJournal, source: TauriJournal, baseline: DrainingSession['baseline']): void {
  target.unknownCommands.push(...source.unknownCommands.slice(baseline.unknownCommands))
  target.fetchViolations.push(...source.fetchViolations.slice(baseline.fetchViolations))
  target.stubbedRequests.push(...source.stubbedRequests.slice(baseline.stubbedRequests))
  target.calls.push(...source.calls.slice(baseline.calls).map((call) => ({ ...call })))
}

function journalForUnexpectedWork(): TauriJournal {
  if (activeSession) return activeSession.journal
  if (drainingSession) return drainingSession.session.journal
  if (!hasStartedStory) return preStoryJournal
  return orphanJournal
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(cloneJsonValue)

  const clone: Record<string, JsonValue> = {}
  for (const [key, child] of Object.entries(value)) clone[key] = cloneJsonValue(child)
  return clone
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  // Non-finite numbers cannot cross Tauri's JSON IPC; reject them like any other non-JSON value.
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false

  return Object.values(value).every(isJsonValue)
}

function asRecord(args: InvokeArgs | undefined, command: string): Record<string, unknown> {
  if (args === undefined || args === null || Array.isArray(args) || args instanceof ArrayBuffer || args instanceof Uint8Array) {
    throw new Error(`Tauri command "${command}" expected an object payload`)
  }
  return args as Record<string, unknown>
}

function asString(value: unknown, command: string, field: string): string {
  if (typeof value !== 'string') throw new Error(`Tauri command "${command}" expected string field "${field}"`)
  return value
}

// Mirrors the real generic store commands: the backend address may only change through the dedicated commands.
const BACKEND_BASE_URL_KEY = 'backendBaseUrl'

function rejectBackendBaseUrlKey(command: string): never {
  throw new Error(
    `'${BACKEND_BASE_URL_KEY}' cannot be changed through ${command}; use store_set_backend_url or store_delete_backend_url`,
  )
}

function builtInStoreHandler(session: StorySession, command: string): TauriCommandHandler | undefined {
  switch (command) {
    case 'store_get':
      return (args) => {
        const payload = asRecord(args, command)
        const key = asString(payload.key, command, 'key')
        return session.settings.has(key) ? cloneJsonValue(session.settings.get(key) as JsonValue) : null
      }
    case 'store_set':
      return (args) => {
        const payload = asRecord(args, command)
        const key = asString(payload.key, command, 'key')
        if (key === BACKEND_BASE_URL_KEY) rejectBackendBaseUrlKey(command)
        if (!isJsonValue(payload.value)) throw new Error(`Tauri command "${command}" received a non-JSON value`)
        session.settings.set(key, cloneJsonValue(payload.value))
      }
    case 'store_delete':
      return (args) => {
        const payload = asRecord(args, command)
        const key = asString(payload.key, command, 'key')
        if (key === BACKEND_BASE_URL_KEY) rejectBackendBaseUrlKey(command)
        session.settings.delete(key)
      }
    case 'store_set_app_settings':
      return (args) => {
        const payload = asRecord(args, command)
        const settings = payload.settings
        if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
          throw new Error(`Tauri command "${command}" expected an object field "settings"`)
        }
        if (BACKEND_BASE_URL_KEY in settings) rejectBackendBaseUrlKey(command)
        // Validate the whole batch before writing anything: the real command runs through
        // apply_config_transaction, so a partially applied batch must not be observable.
        const validated: Array<[string, JsonValue]> = []
        for (const [key, value] of Object.entries(settings)) {
          if (!isJsonValue(value)) throw new Error(`Tauri command "${command}" received a non-JSON value`)
          validated.push([key, cloneJsonValue(value)])
        }
        for (const [key, value] of validated) session.settings.set(key, value)
      }
    case 'store_set_backend_url':
      return (args) => {
        const payload = asRecord(args, command)
        const url = asString(payload.url, command, 'url')
        session.settings.set(BACKEND_BASE_URL_KEY, url)
      }
    case 'store_delete_backend_url':
      return () => {
        session.settings.delete(BACKEND_BASE_URL_KEY)
      }
    default:
      return undefined
  }
}

async function dispatch(command: string, args?: InvokeArgs): Promise<unknown> {
  const session = activeSession ?? drainingSession?.session
  const journal = session?.journal ?? journalForUnexpectedWork()
  const storyId = session?.id ?? NO_ACTIVE_STORY_ID
  journal.calls.push({ command, args })

  // Capture the handler and its session before awaiting, so a later story cannot change this call's target.
  const explicitHandler = session && Object.prototype.hasOwnProperty.call(session.commands, command)
    ? session.commands[command]
    : undefined
  const handler = explicitHandler ?? (session ? builtInStoreHandler(session, command) : undefined)
  if (!handler) {
    journal.unknownCommands.push(command)
    throw new Error(`Unknown Tauri command "${command}" in story "${storyId}"`)
  }

  return handler(args)
}

function installFetchGuard(): void {
  if (typeof globalThis.fetch !== 'function') return

  const currentFetch = globalThis.fetch
  if ((currentFetch as typeof currentFetch & { __sayitGuard?: boolean }).__sayitGuard) return

  const originalFetch = currentFetch.bind(globalThis)
  const guardedFetch: typeof fetch = async (input, init) => {
    let url: URL
    try {
      const raw = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
      url = new URL(raw, globalThis.location?.href ?? 'http://localhost/')
    } catch {
      const violation = String(input)
      journalForUnexpectedWork().fetchViolations.push(violation)
      throw new Error(`Storybook fetch guard rejected an invalid URL: ${violation}`)
    }

    const hostname = url.hostname.toLowerCase()
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]'
    const resolvedUrl = url.toString()
    const activeNetwork = activeSession?.network
    let matchingStub: NetworkStub | undefined
    let matchingPrefixLength = -1
    if (activeNetwork) {
      for (const [prefix, stub] of Object.entries(activeNetwork)) {
        if (resolvedUrl.startsWith(prefix) && prefix.length > matchingPrefixLength) {
          matchingStub = stub
          matchingPrefixLength = prefix.length
        }
      }
    }
    if (matchingStub && activeSession) {
      const request = typeof Request !== 'undefined' && typeof input === 'object' && input !== null && 'url' in input
        ? new Request(input as Request, { ...init, redirect: 'error' })
        : new Request(resolvedUrl, { ...init, redirect: 'error' })
      activeSession.journal.stubbedRequests.push(resolvedUrl)
      return matchingStub(request)
    }
    if (!local) {
      journalForUnexpectedWork().fetchViolations.push(resolvedUrl)
      throw new Error(`Storybook fetch guard rejected non-local URL: ${resolvedUrl}`)
    }

    return originalFetch(input, { ...init, redirect: 'error' })
  }
  Object.defineProperty(guardedFetch, '__sayitGuard', { value: true })
  globalThis.fetch = guardedFetch
  if (typeof window !== 'undefined') window.fetch = guardedFetch
}

export function installTauriBootstrap(): void {
  if (typeof window === 'undefined') return

  installFetchGuard()
  mockWindows('main')
  const internals = (window as Window & {
    __TAURI_INTERNALS__?: { invoke?: unknown }
  }).__TAURI_INTERNALS__
  if (internals?.invoke && internals.invoke === installedInvoke) return

  mockIPC(dispatch, { shouldMockEvents: true })
  installedInvoke = (window as Window & {
    __TAURI_INTERNALS__?: { invoke?: unknown }
  }).__TAURI_INTERNALS__?.invoke
}

function getTauriParameters(context: TauriStoryContext): TauriParameters | undefined {
  const candidate = context.parameters?.tauri
  return candidate && typeof candidate === 'object' ? candidate : undefined
}

function closeSession(session: StorySession): void {
  if (activeSession !== session || session.closed) return
  session.closed = true
  completedJournal = snapshotJournal(session.journal)
  drainingSession = {
    session: {
      id: session.id,
      commands: { ...session.commands },
      network: {},
      settings: new Map(),
      journal: session.journal,
      closed: true,
    },
    baseline: {
      unknownCommands: session.journal.unknownCommands.length,
      fetchViolations: session.journal.fetchViolations.length,
      stubbedRequests: session.journal.stubbedRequests.length,
      calls: session.journal.calls.length,
    },
  }
  session.settings.clear()
  for (const key of Object.keys(session.commands)) delete session.commands[key]
  for (const key of Object.keys(session.network)) delete session.network[key]
  activeSession = undefined

  if (typeof window !== 'undefined') {
    clearMocks()
    installedInvoke = undefined
    installTauriBootstrap()
  }
}

/**
 * Flushes one macrotask so deferred work from the closing story (resolved promises,
 * zero-delay timers) lands while only its draining session is active. Deeper deferrals
 * cannot be attributed - the shared IPC channel carries no story identity - and are the
 * documented residual window of the harness.
 */
export function drainStoryDeferredWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function tauriBeforeEach(context: TauriStoryContext): Promise<() => void> {
  installTauriBootstrap()
  cleanupTauriStory()
  // Drain BEFORE opening the next session: late commands of the closing story then run
  // against its draining session instead of the session this hook is about to create.
  await drainStoryDeferredWork()

  const parameters = getTauriParameters(context)
  const network = context.parameters?.network
  const id = context.id ?? NO_ACTIVE_STORY_ID
  const settings = new Map<string, JsonValue>()
  for (const [key, value] of Object.entries(parameters?.settings ?? {})) {
    if (!isJsonValue(value)) {
      throw new Error(`Story "${id}" seeded a non-JSON value for settings key "${key}"`)
    }
    settings.set(key, cloneJsonValue(value))
  }
  const session: StorySession = {
    id,
    commands: { ...(parameters?.commands ?? {}) },
    network: network ? { ...network } : {},
    settings,
    journal: createJournal(),
    closed: false,
  }
  if (!hasStartedStory) {
    mergeJournal(session.journal, preStoryJournal)
    preStoryJournal = createJournal()
  }
  if (drainingSession) {
    mergeJournalDelta(session.journal, drainingSession.session.journal, drainingSession.baseline)
    drainingSession = undefined
  }
  mergeJournal(session.journal, orphanJournal)
  orphanJournal = createJournal()
  hasStartedStory = true
  completedJournal = createJournal()
  activeSession = session
  return () => closeSession(session)
}

export function cleanupTauriStory(): void {
  if (activeSession) closeSession(activeSession)
}

export function getTauriJournal(): TauriJournal {
  return activeSession?.journal ?? drainingSession?.session.journal ?? completedJournal
}

// The harness owns one active story session per preview window; parallel Docs stories are
// not supported. Between stories, late work is drained one macrotask into the closing
// session's journal; deferrals beyond that window run against the active session and are
// the accepted residual limitation of the shared IPC channel.

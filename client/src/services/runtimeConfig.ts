import * as bridge from './bridge'
import { t } from '@/i18n'

declare const __SAYIT_DEFAULT_SERVER_URL__: string

const BUILTIN_DEFAULT_SERVER_URL =
  typeof __SAYIT_DEFAULT_SERVER_URL__ === 'string'
    ? __SAYIT_DEFAULT_SERVER_URL__.trim()
    : ''

const BACKEND_BASE_URL_STORE_KEY = 'backendBaseUrl'

interface RuntimeEnv {
  VITE_BACKEND_BASE_URL?: string
  VITE_WS_URL?: string
  DEV?: boolean
}

function getEnv(): RuntimeEnv {
  return (import.meta.env as RuntimeEnv | undefined) || {}
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '')
}

function normalizeUrl(value: string | null | undefined): string {
  return trimSlash(String(value || '').trim())
}

function resolveBuiltinDefaultBaseUrl(): string {
  const env = getEnv()
  const value = normalizeUrl(env.VITE_BACKEND_BASE_URL)
  if (value) return value
  return trimSlash(BUILTIN_DEFAULT_SERVER_URL)
}

function resolveEnvOverrideBaseUrl(): string {
  const env = getEnv()
  return normalizeUrl(env.VITE_BACKEND_BASE_URL)
}

let backendBaseUrl = resolveBuiltinDefaultBaseUrl()
let operationQueue: Promise<void> = Promise.resolve()

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationQueue.then(operation, operation)
  operationQueue = result.then(
    () => undefined,
    () => undefined,
  )
  return result
}

export async function initRuntimeConfig(): Promise<void> {
  return enqueue(async () => {
    try {
      await bridge.waitForBackendTlsReady()
    } catch (error) {
      // Continuing is safe: certificates are still validated strictly, only the custom-server exception is off.
      console.error(
        '[runtimeConfig] Native TLS policy is unavailable; the custom-server certificate exception is disabled:',
        error,
      )
    }

    // A user-saved address takes precedence over the environment variable
    const stored = await bridge.storeGet(BACKEND_BASE_URL_STORE_KEY)
    const normalized = normalizeUrl(typeof stored === 'string' ? stored : '')
    if (normalized) {
      backendBaseUrl = normalized
      return
    }
    const envOverride = resolveEnvOverrideBaseUrl()
    if (envOverride) {
      backendBaseUrl = envOverride
      return
    }
    backendBaseUrl = resolveBuiltinDefaultBaseUrl()
  })
}

export function getDefaultBackendBaseUrl(): string {
  return resolveBuiltinDefaultBaseUrl()
}

export function getBackendBaseUrl(): string {
  return backendBaseUrl
}

/** Message for operations that need a server address but none is configured. */
export function serverNotConfiguredMessage(): string {
  return t('runtimeConfig.serverNotConfigured', { section: t('nav.voiceEngine') })
}

/** Connect failure for server mode without an address; callers must not retry it. */
export class ServerNotConfiguredError extends Error {
  constructor() {
    super(serverNotConfiguredMessage())
    this.name = 'ServerNotConfiguredError'
  }
}

// Update checking no longer has any relationship with the speech backend: the update
// source is the pinned fork release manifest (see services/projectLinks.ts and
// features/update/updateChecker.ts). A user-configurable backend URL must never
// decide which installer this machine is allowed to download and run, so the former
// getUpdateBaseUrl / getOfficialUpdateBaseUrl / isOfficialUpdateChannel helpers were
// removed along with the fallback channel they supported.

export async function setBackendBaseUrl(value: string): Promise<string> {
  const normalized = normalizeUrl(value)
  if (!normalized) {
    throw new Error(t('runtimeConfig.emptyServerUrl'))
  }
  return enqueue(async () => {
    await bridge.storeSetBackendUrl(normalized)
    backendBaseUrl = normalized
    return normalized
  })
}

export async function resetBackendBaseUrl(): Promise<string> {
  const defaultUrl = resolveBuiltinDefaultBaseUrl()
  return enqueue(async () => {
    await bridge.storeDeleteBackendUrl()
    backendBaseUrl = defaultUrl
    return defaultUrl
  })
}

export async function getStoredBackendBaseUrl(): Promise<string> {
  return enqueue(async () => {
    const stored = await bridge.storeGet(BACKEND_BASE_URL_STORE_KEY)
    return normalizeUrl(typeof stored === 'string' ? stored : '')
  })
}

/**
 * Drop the active backend URL for this session without changing the store.
 *
 * The startup migration uses this when deleting the legacy address failed: the session
 * must not keep talking to that address, while the stored value stays intact so the next
 * launch can retry the deletion. The Storybook harness also calls it between stories to
 * clear the module-level address that would otherwise leak into the next story.
 */
export async function discardBackendBaseUrlForSession(): Promise<void> {
  return enqueue(async () => {
    backendBaseUrl = resolveBuiltinDefaultBaseUrl()
  })
}

export function getWSUrl(): string {
  const env = getEnv()
  const explicit = normalizeUrl(env.VITE_WS_URL)
  if (explicit) return explicit

  const base = getBackendBaseUrl()
  if (!base) return ''
  if (base.startsWith('https://')) return `${base.replace(/^https:\/\//, 'wss://')}/ws/transcribe`
  if (base.startsWith('http://')) return `${base.replace(/^http:\/\//, 'ws://')}/ws/transcribe`
  return ''
}

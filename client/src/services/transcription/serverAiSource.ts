import { getSetting } from '../store'

export type ServerAiSource = 'managed' | 'custom'
export const SERVER_AI_SOURCE_KEY = 'server.aiSource'

let runtimeSource: ServerAiSource = 'managed'

function normalizeServerAiSource(value: unknown): ServerAiSource {
  return value === 'custom' ? 'custom' : 'managed'
}

/** Reads the persisted source without touching the runtime value, for callers that only need to know it. */
export async function readStoredServerAiSource(): Promise<ServerAiSource> {
  return normalizeServerAiSource(await getSetting(SERVER_AI_SOURCE_KEY, 'managed'))
}

/**
 * Refreshes the runtime value from persisted settings. Called when a provider connects, so that a cold start
 * and a just-imported configuration both run with the correct source.
 */
export async function loadServerAiSource(): Promise<ServerAiSource> {
  runtimeSource = await readStoredServerAiSource()
  return runtimeSource
}

/** start() must read this value synchronously and must not rely on a snapshot left by the previous connect. */
export function getRuntimeServerAiSource(): ServerAiSource {
  return runtimeSource
}

/**
 * The settings page updates this synchronously on save, so the same ServerProvider instance does not keep
 * sending the next request with the old source.
 */
export function setRuntimeServerAiSource(value: ServerAiSource): void {
  runtimeSource = value
}

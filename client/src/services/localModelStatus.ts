import { getSetting } from './store'
import { getDefault } from './defaults'
import { builtinLocalModelName } from '@/i18n/displayNames'

/** Default local model id, derived from the registered settings defaults (services/defaults.ts). */
export const DEFAULT_LOCAL_MODEL_ID = getDefault<string>('localAsr.modelId')

export type LocalModelIpc = <T>(command: string, args?: Record<string, unknown>) => Promise<T>

/**
 * Reads the selected local ASR model. The stored value is normalized in one
 * place: an empty value means the default model, so the Files page, the sidebar
 * engine indicator, and dictation never disagree about which model is selected.
 */
export async function getSelectedLocalModelId(): Promise<string> {
  const stored = await getSetting('localAsr.modelId', DEFAULT_LOCAL_MODEL_ID)
  return String(stored || DEFAULT_LOCAL_MODEL_ID)
}

/**
 * Readiness rule for the selected local model, shared by every consumer: the
 * model is present in the downloaded list and marked complete. A rejection from
 * the list read is propagated instead of being reported as not-installed, so
 * callers keep their own failure policy (settings error, warn log, blocked
 * reason) and can tell "model missing" from "cannot verify".
 */
export async function checkLocalModelInstalled(ipc: LocalModelIpc, modelId: string): Promise<boolean> {
  const downloaded = await ipc<{ id: string; complete: boolean }[]>('list_downloaded_models')
  return downloaded.some((model) => model.id === modelId && model.complete)
}

/**
 * Display name for a local model. Ids from the built-in i18n map resolve
 * without touching IPC; only ids the map does not know ask the catalog,
 * best-effort: this is a display-only dependency, so a failure falls back to
 * the raw id instead of failing the caller.
 */
export async function resolveLocalModelName(ipc: LocalModelIpc, modelId: string): Promise<string> {
  const mapped = builtinLocalModelName(modelId)
  if (mapped !== null) return mapped
  try {
    const catalog = await ipc<{ id: string; name: string }[]>('list_available_models')
    return catalog.find((model) => model.id === modelId)?.name || modelId
  } catch {
    return modelId
  }
}

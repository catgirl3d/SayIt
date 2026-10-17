import type { ServerAiSource } from './serverAiSource'

/**
 * Which component performs the AI stage of a run. The route is a decision, not an
 * execution status: 'client' does not guarantee an LLM request (execution gates such as
 * disableAi, min duration and profile completeness live in the executor, clientAiPolish),
 * and 'integrated' reports a skipped AI stage because the ASR engine already cleaned the text.
 */
export type AiPolishRoute = 'server_managed' | 'client' | 'integrated'

/**
 * Mode-discriminated input: server mode must state its AI source, and only cloud_api can have
 * an integrated-ASR engine. Local mode has no route choice, so its provider calls the client
 * executor directly.
 */
export type AiPolishRouteInput =
  | { workMode: 'server'; serverAiSource: ServerAiSource; selectionAiChosen: boolean }
  | { workMode: 'cloud_api'; integratedAsr: boolean; requireTranslation: boolean; selectionAiChosen: boolean }

export function resolveAiPolishRoute(input: AiPolishRouteInput): AiPolishRoute {
  if (input.selectionAiChosen) return 'client'

  if (input.workMode === 'cloud_api') {
    return input.integratedAsr && !input.requireTranslation ? 'integrated' : 'client'
  }

  // Match the old ServerProvider normalization: only an explicit 'custom' selects the
  // client route, so a stale or unexpected value cannot silently switch the run to
  // client-side AI.
  return input.serverAiSource === 'custom' ? 'client' : 'server_managed'
}

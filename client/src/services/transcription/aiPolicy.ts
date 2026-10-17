import type { AiExecutionSource, AiExecutionStatus, StartOptions } from './types'
import type { ServerAiSource } from './serverAiSource'

/**
 * Which component performs the AI stage of a run. The route is a decision, not an
 * execution status: 'client' does not guarantee an LLM request (execution gates such as
 * disableAi, min duration and profile completeness live in the executor, clientAiPolish),
 * and 'integrated' keeps the existing none/skipped attribution.
 */
export type AiPolishRoute = 'server_managed' | 'client' | 'integrated'

/**
 * Mode-discriminated input: server mode must state its AI source; only cloud_api can have
 * an integrated-ASR engine; local mode currently has exactly one route.
 */
export type AiPolishRouteInput =
  | { workMode: 'server'; serverAiSource: ServerAiSource; selectionAiChosen: boolean }
  | { workMode: 'cloud_api'; integratedAsr: boolean; requireTranslation: boolean; selectionAiChosen: boolean }
  | { workMode: 'local' }

export function resolveAiPolishRoute(input: AiPolishRouteInput): AiPolishRoute {
  if ('selectionAiChosen' in input && input.selectionAiChosen) return 'client'

  if (input.workMode === 'cloud_api') {
    return input.integratedAsr && !input.requireTranslation ? 'integrated' : 'client'
  }

  if (input.workMode === 'server') {
    // Match the old ServerProvider normalization: only an explicit 'custom' selects the
    // client route, so a stale or unexpected value cannot silently switch the run to
    // client-side AI.
    return input.serverAiSource === 'custom' ? 'client' : 'server_managed'
  }

  return 'client'
}

export interface IntegratedSkipResult {
  llmText: string
  llmMs: number
  contextApplied?: boolean
  aiSource: AiExecutionSource
  aiStatus: AiExecutionStatus
}

/**
 * Result of skipping the separate polish stage because the ASR engine has built-in cleanup
 * (Qwen Omni). Moved verbatim from CloudAPIProvider.processAudio.
 */
export function createIntegratedSkipResult(
  startOptions: Pick<StartOptions, 'textContext'> | undefined,
  asrText: string,
): IntegratedSkipResult {
  return {
    llmText: startOptions?.textContext?.selectedText || asrText,
    llmMs: 0,
    contextApplied: startOptions?.textContext ? false : undefined,
    aiSource: 'none',
    aiStatus: 'skipped',
  }
}

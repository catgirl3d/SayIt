import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { addRuntimeEvent } from '../debugLog'
import { loadRuntimeAiConfig } from '../aiRuntimeConfig'
import { assessAiConfig, buildAiProviderConfig } from '@/features/settings/aiProviderCatalog'
import { errorProtocolCode } from '@/lib/errorMessages'
import {
  logAiOutcome,
  outcomeToResultFields,
  resolveAiOutcome,
  type AiOutcomeEvidence,
  type AiSkipCause,
} from './aiOutcome'
import type { AiExecutionSource, AiExecutionStatus, AiFailureReason, StartOptions } from './types'

interface AiResult {
  text: string
  elapsed_ms: number
}

const CLIENT_AI_TIMEOUT_MS = 8_000
let streamSequence = 0

export interface ClientAiPolishResult {
  llmText: string
  llmMs: number
  contextApplied?: boolean
  aiSource: AiExecutionSource
  aiStatus: AiExecutionStatus
  aiFailureReason?: AiFailureReason
  aiProvider?: string
  aiModel?: string
}

interface ClientAiPolishOptions {
  asrText: string
  durationSec: number
  startOptions?: Readonly<StartOptions>
  logSource: string
  /**
   * Checked for the run generation after both the async settings read and the native request
   * finish; false means the result already belongs to an older recording.
   */
  isCurrent?: () => boolean
  /**
   * When provided, the native request streams partial completion text through this callback while the
   * model is still writing. Live subtitles use it to show the translation as it grows; callers that
   * only need the final text (dictation) leave it out and keep the plain request.
   */
  onPartial?: (text: string) => void
}

function safeFallbackText(asrText: string, startOptions?: Readonly<Pick<StartOptions, 'textContext'>>): string {
  // Selection editing relies on the AI understanding the spoken command. When the AI did not actually
  // finish, putting the original selection back is the safe no-op; inserting the ASR text instead would
  // overwrite the body with the command itself (e.g. "make it more formal").
  return startOptions?.textContext?.selectedText || asrText
}

/**
 * Result of a run whose AI stage does not execute: empty recognition, AI disabled, a recording
 * below the duration threshold, or an ASR engine with built-in cleanup (the integrated route).
 *
 * Pure: it writes no `ai.outcome` record, so a caller that skips without entering
 * polishWithClientAi logs through {@link skipPolish}. The cause never changes the result
 * fields; it only labels the log, and the default is for callers that do not log.
 */
export function skippedPolishResult(
  asrText: string,
  startOptions?: Readonly<Pick<StartOptions, 'textContext'>>,
  cause: AiSkipCause = 'ai_disabled',
): ClientAiPolishResult {
  return {
    llmText: safeFallbackText(asrText, startOptions),
    llmMs: 0,
    contextApplied: startOptions?.textContext ? false : undefined,
    ...outcomeToResultFields(resolveAiOutcome({ kind: 'skipped', cause })),
  }
}

/**
 * A skipped result together with its single `ai.outcome` record, for terminators that skip the
 * AI stage on their own authority (the integrated-ASR route) instead of entering polishWithClientAi.
 */
export function skipPolish(
  asrText: string,
  startOptions: Readonly<Pick<StartOptions, 'textContext' | 'aiOutcomeLog'>> | undefined,
  cause: AiSkipCause,
  logSource: string,
): ClientAiPolishResult {
  logAiOutcome(logSource, resolveAiOutcome({ kind: 'skipped', cause }), startOptions)
  return skippedPolishResult(asrText, startOptions, cause)
}

/**
 * Cleans up one piece of ASR text with the currently active client AI profile.
 *
 * The server, cloud API and local recognition sources all share this one place, so that keyless Ollama
 * access, the short-utterance threshold and the selection-editing fallback cannot gradually drift apart
 * across three pipelines. Returns null when the recording's run generation is no longer current.
 */
export async function polishWithClientAi(
  options: ClientAiPolishOptions,
): Promise<ClientAiPolishResult | null> {
  const { asrText, durationSec, startOptions, logSource } = options
  const isCurrent = options.isCurrent ?? (() => true)
  const disableAi = startOptions?.disableAi ?? false
  const aiMinDurationSec = Math.max(0, Number(startOptions?.aiMinDurationSec) || 0)

  // An empty recognition wins over a disabled AI: the log should say there was nothing to clean up.
  if (!asrText.trim()) return skipPolish(asrText, startOptions, 'empty_asr', logSource)
  if (disableAi) return skipPolish(asrText, startOptions, startOptions?.disableAiCause ?? 'ai_disabled', logSource)

  if (aiMinDurationSec > 0 && durationSec < aiMinDurationSec) {
    addRuntimeEvent('info', logSource, 'AI cleanup skipped below duration threshold', {
      durationSec,
      aiMinDurationSec,
    })
    return skipPolish(asrText, startOptions, 'below_min_duration', logSource)
  }

  // A frozen selection-edit snapshot wins over the active profile for this run; the
  // completeness check below applies to it exactly like to the runtime configuration.
  const config = startOptions?.selectionAiConfig ?? await loadRuntimeAiConfig()
  if (!isCurrent()) return null

  // A blank model is normalized to the empty string the native layer reads as
  // "use this provider's default" (Ollama falls back to qwen2.5:7b), so only keyed
  // providers treat it as a hard stop. The backend, not this check, owns the default.
  const model = config.model.trim() ? config.model : ''
  // The single place that turns this run's evidence into metadata and its `ai.outcome` record;
  // the provider and model names are the only configuration that reaches the log.
  const conclude = (evidence: AiOutcomeEvidence, llmMs: number) => {
    const outcome = resolveAiOutcome(evidence)
    logAiOutcome(logSource, outcome, startOptions, {
      provider: config.provider || undefined,
      model: model || undefined,
      llmMs,
    })
    return outcomeToResultFields(outcome)
  }
  const { complete, hasUrl, hasKey, hasModel } = assessAiConfig(config)
  if (!complete) {
    addRuntimeEvent('warn', logSource, 'Custom AI is selected but its active profile is incomplete', {
      provider: config.provider || undefined,
      hasUrl,
      hasKey,
      hasModel,
    })
    return {
      llmText: safeFallbackText(asrText, startOptions),
      llmMs: 0,
      contextApplied: startOptions?.textContext ? false : undefined,
      ...conclude({ kind: 'client_profile_incomplete' }, 0),
      aiProvider: config.provider || undefined,
      aiModel: model || undefined,
    }
  }

  addRuntimeEvent('info', logSource, 'Custom AI cleanup started', {
    provider: config.provider,
    model,
  })

  const stream = Boolean(options.onPartial)
  const requestId = stream ? `polish-${++streamSequence}` : undefined
  let unlisten: (() => void) | undefined
  if (stream) {
    unlisten = await listen<{ requestId?: string; text?: string }>('cloud-polish-delta', (event) => {
      const payload = event.payload
      if (payload?.requestId !== requestId || typeof payload.text !== 'string') return
      if (!isCurrent()) return
      options.onPartial?.(payload.text)
    })
    if (!isCurrent()) {
      unlisten()
      return null
    }
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    const request = invoke<AiResult>('cloud_polish', {
      request: {
        text: asrText,
        ai_config: buildAiProviderConfig({ ...config, model }),
        system_prompt: startOptions?.systemPrompt || null,
        text_context: startOptions?.textContext || null,
        stream,
        request_id: requestId ?? null,
      },
    })
    const result = await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => {
            timedOut = true
            reject(new Error(`Custom AI timed out after ${CLIENT_AI_TIMEOUT_MS}ms`))
          },
          CLIENT_AI_TIMEOUT_MS,
        )
      }),
    ])
    if (!isCurrent()) return null

    const succeeded = Boolean(result.text)
    if (!succeeded) {
      addRuntimeEvent('warn', logSource, 'Custom AI returned an empty result; using raw ASR text')
    }
    return {
      llmText: succeeded ? result.text : safeFallbackText(asrText, startOptions),
      llmMs: result.elapsed_ms,
      contextApplied: startOptions?.textContext ? succeeded : undefined,
      ...conclude({ kind: 'client_result', hasText: succeeded }, result.elapsed_ms),
      aiProvider: config.provider,
      aiModel: model || undefined,
    }
  } catch (error) {
    if (!isCurrent()) return null
    addRuntimeEvent('warn', logSource, 'Custom AI cleanup failed; using raw ASR text', {
      error: String(error),
      provider: config.provider,
      model,
      timedOut,
    })
    return {
      llmText: safeFallbackText(asrText, startOptions),
      llmMs: 0,
      contextApplied: startOptions?.textContext ? false : undefined,
      ...conclude({
        kind: 'client_error',
        timedOut,
        emptyCompletion: errorProtocolCode(error) === 'empty_completion',
      }, 0),
      aiProvider: config.provider,
      aiModel: model || undefined,
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    unlisten?.()
  }
}

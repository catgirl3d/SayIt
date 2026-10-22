import { addRuntimeEvent } from '../debugLog'
import type { AiExecutionSource, AiExecutionStatus, AiFailureReason, StartOptions } from './types'

/**
 * Why a run executed no AI stage. This is log-only: it must never become an AiFailureReason,
 * because that type drives the user-visible overlay notice and the History mark, and a
 * deliberate skip is not a failure to explain.
 */
export type AiSkipCause = 'empty_asr' | 'ai_disabled' | 'below_min_duration' | 'integrated'

/**
 * Content-free projection of the server's `llm_debug`. Transport layers normalize the wire
 * object into these flags and drop everything else: the raw object can carry the error text,
 * the prompt messages, the raw model output and the editor text context, none of which may
 * reach a log.
 */
export interface ServerLlmEvidence {
  /** The server's LLM answered; `provider` is only set on a successful call. */
  provider?: string
  /** The server never called its LLM (disabled, or nothing to polish). */
  skipped?: boolean
  /** The server called its LLM and the call threw; the original text was returned. */
  errored?: boolean
}

/**
 * Project the wire `llm_debug` of a server `final` message onto the content-free evidence flags.
 * Returns undefined when the server sent no object, which is how an older server is told apart
 * from one that reported "no LLM call" with an empty object. The error is detected by the key's
 * presence, not its text: `str(e)` of an exception without a message is an empty string.
 */
export function normalizeServerLlmDebug(raw: unknown): ServerLlmEvidence | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const debug = raw as Record<string, unknown>
  return {
    provider: typeof debug.provider === 'string' && debug.provider ? debug.provider : undefined,
    skipped: debug.skipped === true,
    errored: 'error' in debug,
  }
}

/**
 * Execution evidence of one run's AI stage, as seen by whichever component terminated it.
 * The resolver turns it into metadata; terminators must not derive source/status themselves.
 */
export type AiOutcomeEvidence =
  | { kind: 'skipped'; cause: AiSkipCause }
  /** Managed server AI. `llmDebug` is absent for an older server that does not send it. */
  | { kind: 'server'; llmMs: number; llmDebug?: ServerLlmEvidence }
  | { kind: 'client_profile_incomplete' }
  | { kind: 'client_result'; hasText: boolean }
  | { kind: 'client_error'; timedOut: boolean; emptyCompletion: boolean }
  /** The client executor rejected before its own request handling, e.g. unreadable AI settings. */
  | { kind: 'client_error_before_request' }

/** What the outcome was derived from; an older server only offers the weaker llm_ms signal. */
export type AiOutcomeBasis = 'skip' | 'llm_debug' | 'llm_ms' | 'client'

export interface AiOutcome {
  source: AiExecutionSource
  status: AiExecutionStatus
  /** Same vocabulary as FinalResult.aiFailureReason; set only when the cause is known. */
  reason?: AiFailureReason
  /** True only when a request to an AI backend was actually issued for this run. */
  attempted: boolean
  skipCause?: AiSkipCause
  basis: AiOutcomeBasis
}

/**
 * Map one rejected custom-AI request to the reason the user sees. The Rust adapters reject an
 * empty completion with the stable `empty_completion` code instead of resolving with empty text,
 * so that case is classified here, not in the success path.
 */
function classifyClientFailure(timedOut: boolean, emptyCompletion: boolean): AiFailureReason {
  if (timedOut) return 'timeout'
  if (emptyCompletion) return 'empty_result'
  return 'provider_error'
}

function resolveServerOutcome(llmMs: number, llmDebug: ServerLlmEvidence | undefined): AiOutcome {
  if (!llmDebug) {
    // An older server sends no llm_debug. A positive llm_ms is the only available proof of a call.
    const applied = llmMs > 0
    return {
      source: 'server',
      status: applied ? 'applied' : 'unavailable',
      attempted: applied,
      basis: 'llm_ms',
    }
  }
  // The managed server reports a failed LLM call as 'unavailable', never 'failed': the client has no
  // failure reason for it and existing records already carry this value.
  if (llmDebug.provider) return { source: 'server', status: 'applied', attempted: true, basis: 'llm_debug' }
  return { source: 'server', status: 'unavailable', attempted: Boolean(llmDebug.errored), basis: 'llm_debug' }
}

export function resolveAiOutcome(evidence: AiOutcomeEvidence): AiOutcome {
  switch (evidence.kind) {
    case 'skipped':
      return { source: 'none', status: 'skipped', attempted: false, skipCause: evidence.cause, basis: 'skip' }
    case 'server':
      return resolveServerOutcome(evidence.llmMs, evidence.llmDebug)
    case 'client_profile_incomplete':
      return {
        source: 'custom',
        status: 'unavailable',
        reason: 'incomplete_profile',
        attempted: false,
        basis: 'client',
      }
    case 'client_result':
      return evidence.hasText
        ? { source: 'custom', status: 'applied', attempted: true, basis: 'client' }
        : { source: 'custom', status: 'failed', reason: 'empty_result', attempted: true, basis: 'client' }
    case 'client_error':
      return {
        source: 'custom',
        status: 'failed',
        reason: classifyClientFailure(evidence.timedOut, evidence.emptyCompletion),
        attempted: true,
        basis: 'client',
      }
    case 'client_error_before_request':
      return { source: 'custom', status: 'failed', attempted: false, basis: 'client' }
  }
}

/**
 * The persisted/visible execution metadata of an outcome. `attempted`, `skipCause` and `basis` are
 * deliberately not part of it: they live in the resolver output and the log only. A failure reason
 * the outcome does not have is omitted rather than set to undefined, because result consumers and
 * tests compare these objects strictly.
 */
export function outcomeToResultFields(outcome: AiOutcome): {
  aiSource: AiExecutionSource
  aiStatus: AiExecutionStatus
  aiFailureReason?: AiFailureReason
} {
  return {
    aiSource: outcome.source,
    aiStatus: outcome.status,
    ...(outcome.reason && { aiFailureReason: outcome.reason }),
  }
}

/**
 * Write the single structured `ai.outcome` record for a run. Call it from the component that owns
 * the decision, exactly once per run. `extra` carries only content-free scalars (durations,
 * provider and model names); never pass text, editor context or selection.
 *
 * `startOptions` is required (pass undefined when the caller has none) so that no call site can
 * forget the segment-consumer opt-out: a run started with `aiOutcomeLog: false` writes no record.
 */
export function logAiOutcome(
  logSource: string,
  outcome: AiOutcome,
  startOptions: Readonly<Pick<StartOptions, 'aiOutcomeLog'>> | undefined,
  extra?: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  if (startOptions?.aiOutcomeLog === false) return
  addRuntimeEvent('info', logSource, 'ai.outcome', {
    source: outcome.source,
    status: outcome.status,
    reason: outcome.reason,
    attempted: outcome.attempted,
    skipCause: outcome.skipCause,
    basis: outcome.basis,
    ...extra,
  })
}

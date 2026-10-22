// Server mode provider: the server performs ASR; the AI stage is done either by the server or by a custom
// provider called from this client.

import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { assessAiConfig } from '@/features/settings/aiProviderCatalog'
import * as ws from '../websocket'
import { polishWithClientAi } from './clientAiPolish'
import { resolveAiPolishRoute, type AiPolishRoute } from './aiPolicy'
import { logAiOutcome, outcomeToResultFields, resolveAiOutcome } from './aiOutcome'
import {
  getRuntimeServerAiSource,
  loadServerAiSource,
  type ServerAiSource,
} from './serverAiSource'
import type {
  FinalResult,
  TranscriptionProvider,
  TranscriptionCallbacks,
  StartOptions,
  StopOptions,
} from './types'

export class ServerProvider implements TranscriptionProvider {
  readonly mode = 'server' as const

  private callbacks: TranscriptionCallbacks = {}
  private activeRunId = 0
  private activeStartOpts: Readonly<StartOptions> | undefined
  // Where the configured source runs the AI stage. Readiness reads only this: the websocket re-fires onReady after
  // an automatic reconnect, and a per-run selection override must not decide the connection's llm state.
  private sourceRoute: AiPolishRoute = 'server_managed'
  // Captured in start() for the active run, including the selection-edit override.
  private runRoute: AiPolishRoute = 'server_managed'
  private customAiReady = false
  private customFinalPending = false
  private serverDonePending = false

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    const [storedSource, customProvider, customUrl, customKey, customModel] = await Promise.all([
      loadServerAiSource(),
      getSetting('cloudAi.provider', '') as Promise<string>,
      getSetting('cloudAi.apiUrl', '') as Promise<string>,
      getSetting('cloudAi.apiKey', '') as Promise<string>,
      getSetting('cloudAi.model', '') as Promise<string>,
    ])
    this.sourceRoute = this.routeForSource(storedSource)
    this.customAiReady = assessAiConfig({
      provider: customProvider,
      apiUrl: customUrl,
      apiKey: customKey,
      model: customModel,
    }).complete

    await ws.connect({
      onStateChange: (state) => {
        callbacks.onStateChange?.(state)
      },
      onReady: (data) => {
        callbacks.onReady?.({
          connectionId: data.connectionId,
          asr: data.asr,
          // Custom AI runs on this machine; server llm=false must not mark the whole mode unavailable.
          llm: this.sourceRoute === 'client' ? this.customAiReady : data.llm,
        })
      },
      onASR: (result) => {
        if (this.activeRunId === 0) return
        const isEmpty = !result.text.trim()
        // An empty recognition runs no AI; the recorder's dedicated empty-result branch persists it to
        // history before the final result arrives. The run's single ai.outcome record is written by onFinal.
        const skipped = isEmpty
          ? outcomeToResultFields(resolveAiOutcome({ kind: 'skipped', cause: 'empty_asr' }))
          : undefined
        callbacks.onASR?.({
          text: result.text,
          asrMs: result.asrMs,
          durationSec: result.durationSec,
          aiSource: skipped?.aiSource,
          aiStatus: skipped?.aiStatus,
        })
      },
      onFinal: (serverResult) => {
        const runId = this.activeRunId
        if (runId === 0) return
        // The wire evidence feeds the outcome resolver only; it must not ride along into the public
        // FinalResult that the client route spreads into its callback.
        const { llmDebug, ...result } = serverResult
        if (this.runRoute === 'client') {
          this.customFinalPending = true
          void this.handleCustomFinal(runId, result)
          return
        }

        const aiDisabled = this.activeStartOpts?.disableAi ?? false
        // An empty recognition never reaches the server's LLM, so it is a skip, not an unavailable AI.
        const outcome = resolveAiOutcome(
          !result.asrText.trim()
            ? { kind: 'skipped', cause: 'empty_asr' }
            : aiDisabled
              ? { kind: 'skipped', cause: this.activeStartOpts?.disableAiCause ?? 'ai_disabled' }
              : { kind: 'server', llmMs: result.llmMs, llmDebug },
        )
        logAiOutcome('server', outcome, this.activeStartOpts, { llmMs: result.llmMs, provider: llmDebug?.provider })
        callbacks.onFinal?.({
          asrText: result.asrText,
          llmText: result.llmText,
          asrMs: result.asrMs,
          llmMs: result.llmMs,
          durationSec: result.durationSec,
          asrEngine: result.asrEngine,
          asrModel: result.asrModel,
          contextApplied: result.contextApplied,
          ...outcomeToResultFields(outcome),
          aiProvider: outcome.source === 'none' ? undefined : 'server',
        })
      },
      onDone: () => {
        const runId = this.activeRunId
        if (runId === 0) return
        if (this.customFinalPending) {
          // The server sends done right after final; while the client AI has not finished yet, done must be
          // held back so the recorder does not wrap up the run first.
          this.serverDonePending = true
          return
        }
        this.finishRun(runId)
      },
      onError: (msg) => {
        const runId = this.activeRunId
        if (runId === 0) return
        callbacks.onError?.(msg)
        if (this.activeRunId === runId) this.resetRun()
      },
    })
  }

  acceptsTextContext(): boolean {
    // A custom AI is called by this client with the context as a plain user-message section. The managed server
    // AI gets it over the wire; a legacy server only gets a compatibility capsule written for selection editing.
    return this.routeForSource(getRuntimeServerAiSource()) === 'client' || ws.supportsTextContext()
  }

  start(opts: StartOptions): boolean {
    // The source is whatever the settings page last chose (it can change without a mode switch). A
    // selection-edit service is called by this client for this run only, so it changes the run route alone.
    const source = getRuntimeServerAiSource()
    this.sourceRoute = this.routeForSource(source)
    this.runRoute = resolveAiPolishRoute({
      workMode: 'server',
      serverAiSource: source,
      selectionAiChosen: Boolean(opts.selectionAiConfig),
    })
    this.activeRunId = opts.runId
    this.activeStartOpts = {
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
      textContext: opts.textContext ? { ...opts.textContext } : undefined,
    }
    this.customFinalPending = false
    this.serverDonePending = false

    const wireOptions = this.runRoute === 'client'
      ? {
        ...opts,
        // Custom AI runs on this machine: the server only does ASR, so it must not receive
        // the prompt, the editor text (top-level or the copy inside appContext), or the
        // selection-edit credentials, which carry an API key.
        disableAi: true,
        selectionAiConfig: undefined,
        systemPrompt: undefined,
        textContext: undefined,
        appContext: opts.appContext
          ? { ...opts.appContext, textContext: undefined }
          : opts.appContext,
      }
      // The run-local snapshot belongs to this client in every route; never put it on the wire.
      : { ...opts, selectionAiConfig: undefined }
    const started = ws.sendStart(wireOptions)
    if (!started) this.resetRun()
    return started
  }

  cancel(): void {
    this.resetRun()
    ws.disconnect()
  }

  sendAudio(buffer: ArrayBuffer): void {
    ws.sendAudio(buffer)
  }

  stop(opts?: StopOptions): boolean {
    if (opts?.disableAi && this.activeStartOpts && !this.activeStartOpts.disableAi) {
      this.activeStartOpts = { ...this.activeStartOpts, disableAi: true, disableAiCause: opts.disableAiCause }
    }
    return ws.sendStop(this.runRoute === 'client' ? { ...opts, disableAi: true } : opts)
  }

  disconnect(): void {
    this.resetRun()
    ws.disconnect()
  }

  isReady(): boolean {
    return ws.isConnected()
  }

  private routeForSource(source: ServerAiSource): AiPolishRoute {
    return resolveAiPolishRoute({ workMode: 'server', serverAiSource: source, selectionAiChosen: false })
  }

  private async handleCustomFinal(runId: number, result: FinalResult): Promise<void> {
    const startOptions = this.activeStartOpts
    const polished = await polishWithClientAi({
      asrText: result.asrText,
      durationSec: result.durationSec,
      startOptions,
      logSource: 'server',
      isCurrent: () => this.activeRunId === runId,
    })
    if (!polished || this.activeRunId !== runId) return

    this.callbacks.onFinal?.({
      ...result,
      ...polished,
    })
    this.customFinalPending = false

    if (this.serverDonePending) {
      this.finishRun(runId)
    }
  }

  private finishRun(runId: number): void {
    if (this.activeRunId !== runId) return
    this.callbacks.onDone?.()
    if (this.activeRunId === runId) this.resetRun()
  }

  private resetRun(): void {
    if (this.activeRunId !== 0 && this.customFinalPending) {
      addRuntimeEvent('info', 'server', 'Discarded pending custom AI result for stale run', {
        runId: this.activeRunId,
      })
    }
    this.activeRunId = 0
    this.activeStartOpts = undefined
    this.customFinalPending = false
    this.serverDonePending = false
  }
}

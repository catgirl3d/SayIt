// Local mode provider
// Audio is buffered locally; stop triggers local ASR inference on the Rust side
// After ASR completes, the shared client-AI executor may clean up the text

import { invoke } from '@tauri-apps/api/core'
import { getSetting } from '../store'
import { addRuntimeEvent } from '../debugLog'
import { checkLocalModelInstalled, getSelectedLocalModelId } from '../localModelStatus'
import { BufferedProvider } from './BufferedProvider'
import { polishWithClientAi } from './clientAiPolish'
import { logAiOutcome, outcomeToResultFields, resolveAiOutcome } from './aiOutcome'
import type { TranscriptionCallbacks } from './types'

export class LocalProvider extends BufferedProvider {
  readonly mode = 'local' as const

  /**
   * Local readiness = the selected model is completely downloaded.
   *
   * This once reported `asr: true` no matter what (even from the preload
   * failure catch), so a wiped model still started recording via hotkey and
   * only failed at recognition — while the settings page promised the hotkey
   * would do nothing. Now it reports honestly and RecorderOrchestrator blocks
   * the run with a prompt.
   *
   * The readiness rule itself lives in services/localModelStatus, shared with
   * the Files page and the bottom-left engine indicator (stores/modeStatus),
   * so all three cannot disagree on screen.
   */
  protected async onConnect(callbacks: TranscriptionCallbacks): Promise<boolean> {
    const modelId = await getSelectedLocalModelId()

    let installed: boolean
    try {
      installed = await checkLocalModelInstalled(invoke, modelId)
    } catch (err) {
      // Do not claim readiness when the list cannot be read: block with a
      // warning now instead of failing after the recording is done.
      addRuntimeEvent('warn', 'local', 'Could not read local model list; provider is not ready', { error: String(err) })
      callbacks.onReady?.({ asr: false, llm: false })
      return false
    }

    if (!installed) {
      addRuntimeEvent('warn', 'local', 'Selected local model is not downloaded; provider is not ready', { modelId })
      callbacks.onReady?.({ asr: false, llm: false })
      return false
    }

    // Already downloaded: a preload failure (corrupt file, broken GPU backend)
    // does not mean the model is unusable — the real failure will surface at
    // recognition with a concrete reason, so treat the provider as ready.
    try {
      const accelerator = (await getSetting('localAsr.accelerator', 'auto')) as string
      await invoke<string>('preload_local_model', { modelId, accelerator })
    } catch (err) {
      addRuntimeEvent('warn', 'local', 'Local model preload failed; provider remains marked ready', {
        error: String(err),
      })
    }
    callbacks.onReady?.({ asr: true, llm: false })
    return true
  }

  protected async processAudio(audioB64: string, durationSec: number, runId: number): Promise<void> {
    if (!this.isRunCurrent(runId)) return
    const startOpts = this.startOpts
    const startTime = performance.now()

    addRuntimeEvent('info', 'local', 'Local ASR started', { durationSec, runId })
    let asrText: string
    let asrMs: number

    try {
      // Use the same normalized id that onConnect validated, so a provider that
      // reported ready always transcribes exactly the model it checked.
      const modelId = await getSelectedLocalModelId()
      if (!this.isRunCurrent(runId)) return
      const language = startOpts?.language || 'auto'
      const accelerator = await getSetting('localAsr.accelerator', 'auto')
      if (!this.isRunCurrent(runId)) return

      const result = await invoke<{ text: string; elapsed_ms: number }>('local_transcribe', {
        audioB64,
        modelId,
        language,
        accelerator,
      })
      if (!this.isRunCurrent(runId)) return
      asrText = result.text
      asrMs = result.elapsed_ms
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('error', 'local', 'Local ASR failed', { error: String(err) })
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
      return
    }

    if (!this.isRunCurrent(runId)) return
    // An empty recognition runs no AI. The recorder persists the empty record from this ASR result,
    // so the execution metadata must travel with it, not only with the final.
    const emptyOutcome = asrText.trim()
      ? undefined
      : resolveAiOutcome({ kind: 'skipped', cause: 'empty_asr' })
    this.callbacks.onASR?.({
      text: asrText,
      asrMs,
      durationSec,
      ...(emptyOutcome && outcomeToResultFields(emptyOutcome)),
    })

    if (emptyOutcome) {
      if (!this.isRunCurrent(runId)) return
      logAiOutcome('local', emptyOutcome, startOpts)
      this.callbacks.onFinal?.({
        asrText: '',
        llmText: '',
        asrMs,
        llmMs: 0,
        durationSec,
        ...outcomeToResultFields(emptyOutcome),
      })
      this.callbacks.onDone?.()
      return
    }

    const polish = await polishWithClientAi({
      asrText,
      durationSec,
      startOptions: startOpts,
      logSource: 'local',
      isCurrent: () => this.isRunCurrent(runId),
    })
    if (!polish || !this.isRunCurrent(runId)) return

    const totalMs = Math.round(performance.now() - startTime)
    addRuntimeEvent('info', 'local', 'Processing complete', {
      durationSec,
      asrMs,
      llmMs: polish.llmMs,
      totalMs,
      runId,
    })

    this.callbacks.onFinal?.({
      asrText,
      asrMs,
      durationSec,
      ...polish,
    })
    this.callbacks.onDone?.()
  }
}

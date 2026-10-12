import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { addRuntimeEvent } from '../debugLog'
import { loadRuntimeAiConfig } from '../aiRuntimeConfig'
import { buildAiProviderConfig, findProvider } from '@/features/settings/aiProviderCatalog'
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
  /** 异步读设置和原生请求结束后都要验代；false 表示结果已经属于旧录音。 */
  isCurrent?: () => boolean
  /**
   * When provided, the native request streams partial completion text through this callback while the
   * model is still writing. Live subtitles use it to show the translation as it grows; callers that
   * only need the final text (dictation) leave it out and keep the plain request.
   */
  onPartial?: (text: string) => void
}

function safeFallbackText(asrText: string, startOptions?: Readonly<StartOptions>): string {
  // 选区编辑依赖 AI 理解口述命令。AI 没有真正完成时，回填原选区才是安全 no-op；
  // 直接回填 ASR 会把“改成更正式”这种命令本身覆盖进正文。
  return startOptions?.textContext?.selectedText || asrText
}

/**
 * 使用当前启用的客户端 AI 档案整理一段 ASR 文本。
 *
 * 服务器、云 API、本地三种识别来源共用这一处，避免 Ollama 免密、短语音门槛、
 * 选区编辑回退在三条链路里逐渐漂移。返回 null 表示录音代次已经失效。
 */
export async function polishWithClientAi(
  options: ClientAiPolishOptions,
): Promise<ClientAiPolishResult | null> {
  const { asrText, durationSec, startOptions, logSource } = options
  const isCurrent = options.isCurrent ?? (() => true)
  const disableAi = startOptions?.disableAi ?? false
  const aiMinDurationSec = Math.max(0, Number(startOptions?.aiMinDurationSec) || 0)

  if (!asrText.trim()) {
    return {
      llmText: safeFallbackText(asrText, startOptions),
      llmMs: 0,
      contextApplied: startOptions?.textContext ? false : undefined,
      aiSource: 'none',
      aiStatus: 'skipped',
    }
  }

  if (disableAi) {
    return {
      llmText: safeFallbackText(asrText, startOptions),
      llmMs: 0,
      contextApplied: startOptions?.textContext ? false : undefined,
      aiSource: 'none',
      aiStatus: 'skipped',
    }
  }

  if (aiMinDurationSec > 0 && durationSec < aiMinDurationSec) {
    addRuntimeEvent('info', logSource, 'AI cleanup skipped below duration threshold', {
      durationSec,
      aiMinDurationSec,
    })
    return {
      llmText: safeFallbackText(asrText, startOptions),
      llmMs: 0,
      contextApplied: startOptions?.textContext ? false : undefined,
      aiSource: 'none',
      aiStatus: 'skipped',
    }
  }

  const config = await loadRuntimeAiConfig()
  if (!isCurrent()) return null

  const keyless = Boolean(findProvider(config.provider).keyless)
  const complete = Boolean(
    config.apiUrl.trim()
    && config.model.trim()
    && (config.apiKey.trim() || keyless),
  )
  if (!complete) {
    addRuntimeEvent('warn', logSource, 'Custom AI is selected but its active profile is incomplete', {
      provider: config.provider || undefined,
      hasUrl: Boolean(config.apiUrl.trim()),
      hasKey: Boolean(config.apiKey.trim()) || keyless,
      hasModel: Boolean(config.model.trim()),
    })
    return {
      llmText: safeFallbackText(asrText, startOptions),
      llmMs: 0,
      contextApplied: startOptions?.textContext ? false : undefined,
      aiSource: 'custom',
      aiStatus: 'unavailable',
      aiFailureReason: 'incomplete_profile',
      aiProvider: config.provider || undefined,
      aiModel: config.model || undefined,
    }
  }

  addRuntimeEvent('info', logSource, 'Custom AI cleanup started', {
    provider: config.provider,
    model: config.model,
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
        ai_config: buildAiProviderConfig(config),
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
      aiSource: 'custom',
      aiStatus: succeeded ? 'applied' : 'failed',
      aiFailureReason: succeeded ? undefined : 'empty_result',
      aiProvider: config.provider,
      aiModel: config.model,
    }
  } catch (error) {
    if (!isCurrent()) return null
    addRuntimeEvent('warn', logSource, 'Custom AI cleanup failed; using raw ASR text', {
      error: String(error),
      provider: config.provider,
      model: config.model,
      timedOut,
    })
    return {
      llmText: safeFallbackText(asrText, startOptions),
      llmMs: 0,
      contextApplied: startOptions?.textContext ? false : undefined,
      aiSource: 'custom',
      aiStatus: 'failed',
      aiFailureReason: timedOut ? 'timeout' : 'provider_error',
      aiProvider: config.provider,
      aiModel: config.model,
    }
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    unlisten?.()
  }
}

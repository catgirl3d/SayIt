// 云 API 模式 Provider
// 豆包 ASR：边录边发（实时流式）
// 其他 ASR：录完再发（BufferedProvider）

import { isQwenOmniProvider, isStreamingDisplayReady } from '@/lib/asrModels'
import {
  buildAsrProviderConfig,
  CUSTOM_ASR_PROVIDER,
  effectiveAsrCredentials,
  resolveAsrRequestMetadata,
  type AsrProviderConfig,
  type AsrProfile,
} from '@/features/settings/asrProviderCatalog'
import { loadActiveAsrProfile } from '@/features/settings/asrProfileStore'
import { errorProtocolCode } from '@/lib/errorMessages'
import { normalizeSpeechInputLanguage } from '../speechInputLanguage'
import { uint8ArrayToBase64 } from '@/lib/encoding'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getSetting } from '../store'
import { restoreHotwordSpacing } from '../textPostProcess'
import { addRuntimeEvent } from '../debugLog'
import { polishWithClientAi } from './clientAiPolish'
import { transcribeCustomAsr } from './customAsrRequest'
import {
  DEEPGRAM_KEYTERM_LIMIT,
  type AsrWarningCode,
  type TranscriptionProvider,
  type TranscriptionCallbacks,
  type StartOptions,
  type StopOptions,
  type LiveAsrCallbacks,
  type LiveAsrError,
  type LiveAsrResult,
  type LiveAsrSession,
  type LiveAsrWarning,
  type WorkMode,
} from './types'

interface AsrResult { text: string; elapsed_ms: number; warning?: AsrWarningCode }

const LIVE_PCM_BUDGET_BYTES = 384_000
const LIVE_PCM_BATCH_BYTES = 16_000
const LIVE_CONTROL_QUEUE_LIMIT = 32
const LIVE_OPEN_STALL_MS = 10_000
const LIVE_OPERATION_STALL_MS = 5_000

interface NativeLiveResult {
  sessionId: string
  resultId: number
  audioStartMs: number
  audioEndMs: number
  text: string
  isFinal: boolean
  speechFinal: boolean
  fromFinalize: boolean
}

interface LiveAudioOperation {
  kind: 'audio'
  buffer: ArrayBuffer
  offset: number
}

interface LiveFinalizeOperation {
  kind: 'finalize'
  resolve: () => void
  reject: (error: Error) => void
}

type LiveOperation = LiveAudioOperation | LiveFinalizeOperation

interface LiveOwner {
  sessionId: string
  callbacks: LiveAsrCallbacks
  asrEngine: string
  asrModel: string
  cancelled: boolean
  closing: boolean
  terminalError: Error | null
  nativeOpenAttempted: boolean
  nativeOpenOperation: Promise<{ opened: boolean; payload: unknown }> | null
  nativeOpenError: unknown
  unlisteners: Array<() => void>
  operations: LiveOperation[]
  pendingAudioBytes: number
  audioFrontier: number
  pendingFinalizeCount: number
  lastFinalize: { frontier: number; promise: Promise<void> } | null
  drainPromise: Promise<void> | null
  closePromise: Promise<void> | null
}

function isNativeLiveResult(value: unknown): value is NativeLiveResult {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return typeof result.sessionId === 'string'
    && typeof result.resultId === 'number'
    && Number.isFinite(result.resultId)
    && typeof result.audioStartMs === 'number'
    && Number.isFinite(result.audioStartMs)
    && typeof result.audioEndMs === 'number'
    && Number.isFinite(result.audioEndMs)
    && typeof result.text === 'string'
    && typeof result.isFinal === 'boolean'
    && typeof result.speechFinal === 'boolean'
    && typeof result.fromFinalize === 'boolean'
}

/**
 * 千问两个流式模型各有一组原生命令。
 *
 * 它们是**两套 WebSocket 协议**，不是同一个接口的两个模型名：
 *   · qwen_realtime      → OpenAI-Realtime 风格（/api-ws/v1/realtime）
 *   · qwen_audio_stream  → DashScope duplex run-task（/api-ws/v1/inference）
 * Rust 侧因此各有一份实现（asr_qwen_realtime.rs / asr_qwen_audio_stream.rs），
 * 这里要记住本次会话用的是哪一组，收尾时才不会去 finish 另一条没开的会话。
 */
const QWEN_STREAM_COMMANDS = {
  qwen_realtime: {
    open: 'qwen_stream_open',
    send: 'qwen_stream_send',
    finish: 'qwen_stream_finish',
    close: 'qwen_stream_close',
  },
  qwen_audio_stream: {
    open: 'qwen_audio_stream_open',
    send: 'qwen_audio_stream_send',
    finish: 'qwen_audio_stream_finish',
    close: 'qwen_audio_stream_close',
  },
} as const

type QwenStreamProvider = keyof typeof QWEN_STREAM_COMMANDS
type QwenStreamCommands = typeof QWEN_STREAM_COMMANDS[QwenStreamProvider]
type NativeOpenCommand = 'doubao_stream_open' | 'deepgram_stream_open' | QwenStreamCommands['open']
type NativeFinishCommand = 'doubao_stream_finish' | 'deepgram_stream_finish' | QwenStreamCommands['finish']

function isQwenStreamProvider(provider: string): provider is QwenStreamProvider {
  return provider === 'qwen_realtime' || provider === 'qwen_audio_stream'
}

/**
 * Whether this run can open a Deepgram socket whose keyterm-overflow retry fails
 * terminally. Only then must the buffered path wait for the stream startup before
 * it decides, so the retry failure is never answered with a third billed request.
 */
function awaitsDeepgramKeytermStartup(profile: AsrProfile | null, startOpts: Readonly<StartOptions>): boolean {
  return profile?.provider === 'deepgram'
    && profile.deepgramKeytermsEnabled === true
    && Boolean(startOpts.hotwords?.length)
    && !startOpts.disableStreaming
}

export class CloudAPIProvider implements TranscriptionProvider {
  readonly mode: WorkMode = 'cloud_api'

  private callbacks: TranscriptionCallbacks = {}
  private pcmBuffers: ArrayBuffer[] = []
  private sessionActive = false
  private activeRunId = 0
  private activeStartOpts: Readonly<StartOptions> | undefined
  private activeProfileSnapshot: Promise<AsrProfile | null> | null = null
  private ready = false

  // Doubao / Qwen / Deepgram streaming state
  private isDoubaoStream = false
  private isQwenStream = false
  private isDeepgramStream = false
  private doubaoStreamReady = false
  private qwenStreamReady = false
  private deepgramStreamReady = false
  /** 本次会话用的千问命令组；没走千问流式时为 null */
  private qwenCommands: QwenStreamCommands | null = null
  private streamStartTime = 0
  private pendingChunks: ArrayBuffer[] = []
  private flushTimer: ReturnType<typeof setInterval> | null = null

  // 流式实时显示：中间结果事件的取消监听函数
  private partialUnlisten: (() => void) | null = null

  // 流式发送串行化：所有音频包经此链路顺序发送，保证收尾负包一定排在最后，
  // 避免「音频包在负包之后到达」导致服务端报 last packet has been received already。
  private sendLock: Promise<void> = Promise.resolve()
  private streamFinishing = false

  // 原生流生命周期串行化：open / finish / close 共用 Provider 级队列。
  // cancel 会先把 close 排入旧 open 之后；下一代 open 因而只能在旧 close 完成后执行。
  private nativeLifecycleQueue: Promise<void> = Promise.resolve()
  private liveOwner: LiveOwner | null = null
  private streamStartup: Promise<void> | null = null
  /** Terminal retry failure parked by the streaming startup, bound to the run that produced it. */
  private streamOpenFailure: { runId: number; error: string } | null = null
  private asrWarning: AsrWarningCode | undefined

  async connect(callbacks: TranscriptionCallbacks): Promise<void> {
    this.callbacks = callbacks
    this.ready = true
    callbacks.onStateChange?.('connected')
    callbacks.onReady?.({ asr: true, llm: true })
  }

  start(opts: StartOptions): boolean {
    if (!this.ready) {
      addRuntimeEvent('error', 'cloud_api', 'Start failed: provider is not ready')
      return false
    }

    // 新会话不得复用旧会话的任何逻辑状态；旧 close 会先进入生命周期队列。
    if (this.activeRunId !== 0) this.cancel()

    const runOpts = this.snapshotStartOptions(opts)
    const profileSnapshot = loadActiveAsrProfile()
    this.pcmBuffers = []
    this.sessionActive = true
    this.activeRunId = runOpts.runId
    this.activeStartOpts = runOpts
    this.activeProfileSnapshot = profileSnapshot
    this.isDoubaoStream = false
    this.isQwenStream = false
    this.isDeepgramStream = false
    this.doubaoStreamReady = false
    this.qwenStreamReady = false
    this.deepgramStreamReady = false
    this.qwenCommands = null
    this.streamStartTime = performance.now()
    this.pendingChunks = []
    this.streamFinishing = false
    this.sendLock = Promise.resolve()
    this.streamOpenFailure = null
    this.asrWarning = undefined

    // 异步判断供应商并建连；所有异步步骤只使用本次 run 的 StartOptions 快照。
    this.streamStartup = this.tryStartRealtimeStream(runOpts.runId, runOpts, profileSnapshot)

    return true
  }

  private snapshotStartOptions(opts: StartOptions): Readonly<StartOptions> {
    return {
      ...opts,
      hotwords: opts.hotwords ? [...opts.hotwords] : undefined,
      textContext: opts.textContext ? { ...opts.textContext } : undefined,
    }
  }

  private isRunCurrent(runId: number): boolean {
    return runId !== 0 && this.activeRunId === runId
  }

  private reportWarning(runId: number, warning: unknown): void {
    if (!this.isRunCurrent(runId) || warning !== DEEPGRAM_KEYTERM_LIMIT || this.asrWarning === warning) return
    this.asrWarning = warning
    addRuntimeEvent('warn', 'cloud_api', 'Deepgram dictionary exceeded the keyterm limit; recognition continued without hints')
    this.callbacks.onWarning?.(warning)
  }

  private completeRun(runId: number): void {
    if (!this.isRunCurrent(runId)) return

    // 先让本次 run 失效，后续迟到结果一律丢弃；close 在队列中等待旧发送链排空。
    this.activeRunId = 0
    this.activeStartOpts = undefined
    this.activeProfileSnapshot = null
    const sendLockToDrain = this.sendLock
    this.sessionActive = false
    this.pcmBuffers = []
    this.pendingChunks = []
    this.streamFinishing = true
    this.isDoubaoStream = false
    this.isQwenStream = false
    this.isDeepgramStream = false
    this.doubaoStreamReady = false
    this.qwenStreamReady = false
    this.deepgramStreamReady = false
    this.qwenCommands = null
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    this.teardownPartials()
    void this.queueNativeClose(sendLockToDrain, this.liveOwner !== null)
  }

  private enqueueNativeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.nativeLifecycleQueue.then(operation)
    this.nativeLifecycleQueue = result.then(() => undefined, () => undefined)
    return result
  }

  private queueNativeClose(sendLockToDrain: Promise<void>, preserveLiveDeepgramOwner = false): Promise<void> {
    return this.enqueueNativeLifecycle(async () => {
      await sendLockToDrain.catch(() => { })
      // 逐个关：每个 close 在没有会话时都是无操作，所以不需要先判断开了哪一个。
      await invoke('doubao_stream_close').catch(() => { })
      await invoke('qwen_stream_close').catch(() => { })
      await invoke('qwen_audio_stream_close').catch(() => { })
      if (!preserveLiveDeepgramOwner) await invoke('deepgram_stream_close').catch(() => { })
    })
  }

  private invokeNativeOpen(
    runId: number,
    command: NativeOpenCommand,
    args: Record<string, unknown>,
  ): Promise<{ opened: boolean; payload: unknown }> {
    return this.enqueueNativeLifecycle(async () => {
      if (!this.isRunCurrent(runId)) return { opened: false, payload: null }
      let payload: unknown
      try {
        payload = await invoke<unknown>(command, args)
      } catch (err) {
        if (!this.isRunCurrent(runId)) return { opened: false, payload: null }
        throw err
      }
      if (!this.isRunCurrent(runId)) return { opened: false, payload }
      return { opened: true, payload }
    })
  }

  private invokeNativeFinish(
    runId: number,
    command: NativeFinishCommand,
  ): Promise<string | undefined> {
    return this.enqueueNativeLifecycle(async () => {
      if (!this.isRunCurrent(runId)) return undefined
      try {
        const text = await invoke<string>(command)
        if (!this.isRunCurrent(runId)) return undefined
        return text
      } catch (err) {
        if (!this.isRunCurrent(runId)) return undefined
        throw err
      }
    })
  }

  /** 订阅 Rust 上抛的流式中间识别结果，实时转发给上层用于悬浮窗上屏 */
  private async subscribePartials(runId: number): Promise<void> {
    if (this.partialUnlisten) return
    let partialCount = 0
    const unlisten = await listen<{ text?: string }>('asr-partial', (event) => {
      if (!this.isRunCurrent(runId)) return
      if (!this.sessionActive && this.pcmBuffers.length === 0) return
      const text = event.payload?.text ?? ''
      partialCount++
      // 只记录第一条，避免刷屏；证明前端确实收到了 Rust 上抛的中间结果
      if (partialCount === 1) {
        addRuntimeEvent('info', 'cloud_api', 'First streaming partial received', { textLen: text.length })
      }
      this.callbacks.onPartialASR?.(text)
    })
    if (!this.isRunCurrent(runId) || this.partialUnlisten) {
      unlisten()
      return
    }
    this.partialUnlisten = unlisten
    addRuntimeEvent('info', 'cloud_api', 'Subscribed to asr-partial events')
  }

  private teardownPartials(): void {
    if (this.partialUnlisten) {
      this.partialUnlisten()
      this.partialUnlisten = null
    }
  }

  sendAudio(buffer: ArrayBuffer): void {
    if (!this.sessionActive) return

    // 始终缓存一份（用于非豆包场景 + 音频保存）
    this.pcmBuffers.push(buffer.slice(0))

    // 豆包/千问流式：攒到 pendingChunks，由定时器批量发送。
    // 收尾阶段不再接收新音频，确保负包之后不会再有音频包。
    if ((this.isDoubaoStream || this.isQwenStream || this.isDeepgramStream) && !this.streamFinishing) {
      this.pendingChunks.push(buffer.slice(0))
    }
  }

  stop(_opts?: StopOptions): boolean {
    if (!this.sessionActive) return false
    const runId = this.activeRunId
    const runOpts = this.activeStartOpts
    const profileSnapshot = this.activeProfileSnapshot
    if (!runOpts || runOpts.runId !== runId || !profileSnapshot) return false
    this.sessionActive = false
    void this.runProcess(runId, runOpts, profileSnapshot)
    return true
  }

  cancel(): void {
    const liveOwner = this.liveOwner
    if (liveOwner) {
      // Keep ownership until serialized cleanup completes; cancellation cannot await from this API.
      if (!liveOwner.closing && !liveOwner.terminalError) {
        this.failLiveOwner(liveOwner, new Error('Live ASR session was cancelled'))
      }
      void this.closeLiveOwner(liveOwner).catch((error: unknown) => {
        addRuntimeEvent('error', 'cloud_api', 'Live ASR cleanup failed after cancellation', {
          sessionId: liveOwner.sessionId,
          error: String(error),
        })
      })
    }

    // 必须先使 run 失效，再清理前端状态；close 最后入队且等待此刻的旧发送链。
    this.activeRunId = 0
    this.activeStartOpts = undefined
    this.activeProfileSnapshot = null
    const sendLockToDrain = this.sendLock
    this.sessionActive = false
    this.pcmBuffers = []
    this.pendingChunks = []
    this.streamFinishing = true
    this.isDoubaoStream = false
    this.isQwenStream = false
    this.isDeepgramStream = false
    this.doubaoStreamReady = false
    this.qwenStreamReady = false
    this.deepgramStreamReady = false
    this.qwenCommands = null
    this.teardownPartials()
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    void this.queueNativeClose(sendLockToDrain, liveOwner !== null)
  }

  disconnect(): void {
    this.cancel()
    this.ready = false
    this.callbacks.onStateChange?.('disconnected')
  }

  isReady(): boolean {
    return this.ready
  }

  async openLive(options: StartOptions, callbacks: LiveAsrCallbacks): Promise<LiveAsrSession | null> {
    if (this.liveOwner) {
      if (this.liveOwner.closing) {
        throw new Error('Live ASR cleanup is pending; call closeLive() again after the native operation settles')
      }
      throw new Error('A live ASR session is already active; call closeLive() before opening another')
    }

    const startOptions = this.snapshotStartOptions(options)
    const owner: LiveOwner = {
      sessionId: crypto.randomUUID(),
      callbacks,
      asrEngine: '',
      asrModel: '',
      cancelled: false,
      closing: false,
      terminalError: null,
      nativeOpenAttempted: false,
      nativeOpenOperation: null,
      nativeOpenError: undefined,
      unlisteners: [],
      operations: [],
      pendingAudioBytes: 0,
      audioFrontier: 0,
      pendingFinalizeCount: 0,
      lastFinalize: null,
      drainPromise: null,
      closePromise: null,
    }
    this.liveOwner = owner

    try {
      const loadedProfile = await loadActiveAsrProfile()
      if (!this.isLiveOwnerCurrent(owner)) return null
      if (!loadedProfile || loadedProfile.provider !== 'deepgram') {
        await this.closeLiveOwner(owner)
        return null
      }

      const profile = { ...loadedProfile }
      const metadata = resolveAsrRequestMetadata(profile)
      owner.asrEngine = metadata.engine
      owner.asrModel = metadata.model ?? profile.model

      if (!await this.subscribeLiveEvents(owner)) {
        await this.closeLiveOwner(owner)
        return null
      }

      const openOperation = this.invokeLiveNative(owner, 'deepgram_stream_open', {
        config: buildAsrProviderConfig(profile, normalizeSpeechInputLanguage(startOptions.language)),
        sampleRate: 16000,
        hotwords: startOptions.hotwords ?? [],
        sessionId: owner.sessionId,
      }, LIVE_OPEN_STALL_MS, () => {
        if (!this.isLiveOwnerCurrent(owner) || owner.terminalError) return false
        owner.nativeOpenAttempted = true
        return true
      }).then((payload) => ({ opened: owner.nativeOpenAttempted, payload }))
      owner.nativeOpenOperation = openOperation
      const opened = await openOperation
      if (owner.terminalError) throw owner.terminalError
      if (!opened.opened || owner.cancelled || this.liveOwner !== owner) {
        await this.closeLiveOwner(owner)
        return null
      }

      if (opened.payload === DEEPGRAM_KEYTERM_LIMIT) {
        const warning: LiveAsrWarning = {
          sessionId: owner.sessionId,
          code: DEEPGRAM_KEYTERM_LIMIT,
          asrEngine: owner.asrEngine,
          asrModel: owner.asrModel,
        }
        owner.callbacks.onWarning(warning)
      }

      return {
        sessionId: owner.sessionId,
        sendAudio: (buffer) => this.sendLiveAudio(owner, buffer),
        finalize: () => this.finalizeLive(owner),
        close: () => this.closeLiveOwner(owner),
      }
    } catch (error) {
      if (this.liveOwner === owner) {
        try {
          await this.closeLiveOwner(owner)
        } catch (cleanupError) {
          const openError = owner.nativeOpenError ?? error
          throw new Error(
            `Live ASR open failed: ${String(openError)}; cleanup failed: ${String(cleanupError)}`,
            { cause: cleanupError },
          )
        }
        throw owner.nativeOpenError ?? error
      }
      throw error
    }
  }

  async closeLive(): Promise<void> {
    const owner = this.liveOwner
    if (!owner) return
    await this.closeLiveOwner(owner)
  }

  private isLiveOwnerCurrent(owner: LiveOwner): boolean {
    return this.liveOwner === owner && !owner.cancelled
  }

  private async subscribeLiveEvents(owner: LiveOwner): Promise<boolean> {
    const resultUnlisten = await listen<NativeLiveResult>('deepgram-live-result', (event) => {
      const result = event.payload
      if (!this.isLiveOwnerCurrent(owner) || owner.terminalError || !isNativeLiveResult(result)) return
      if (result.sessionId !== owner.sessionId) return
      const liveResult: LiveAsrResult = {
        ...result,
        asrEngine: owner.asrEngine,
        asrModel: owner.asrModel,
      }
      owner.callbacks.onResult(liveResult)
    })
    if (!this.isLiveOwnerCurrent(owner)) {
      resultUnlisten()
      return false
    }
    owner.unlisteners.push(resultUnlisten)

    const errorUnlisten = await listen<{ sessionId: string; message: string }>('deepgram-live-error', (event) => {
      const payload = event.payload
      if (this.liveOwner !== owner || owner.terminalError || !payload) return
      if (payload.sessionId !== owner.sessionId || typeof payload.message !== 'string') return
      this.failLiveOwner(owner, new Error(payload.message))
    })
    if (!this.isLiveOwnerCurrent(owner)) {
      errorUnlisten()
      return false
    }
    owner.unlisteners.push(errorUnlisten)
    return true
  }

  private async invokeLiveNative(
    owner: LiveOwner,
    command: string,
    args: Record<string, unknown>,
    stallTimeoutMs = LIVE_OPERATION_STALL_MS,
    beforeInvoke: () => boolean = () => true,
  ): Promise<unknown> {
    let rejectStall!: (error: Error) => void
    let stallTimer: ReturnType<typeof setTimeout> | null = null
    const stalled = new Promise<never>((_, reject) => { rejectStall = reject })

    // Keep the lifecycle queue tied to the uncancellable invoke; only the caller's wait times out.
    const operation = this.enqueueNativeLifecycle(() => {
      if (!beforeInvoke()) return Promise.resolve(undefined)
      const nativeOperation = invoke<unknown>(command, args)
      stallTimer = setTimeout(() => {
        const error = new Error(`Live ASR ${command} operation stalled`)
        this.failLiveOwner(owner, error)
        rejectStall(error)
      }, stallTimeoutMs)
      void nativeOperation.then(
        () => { if (stallTimer) clearTimeout(stallTimer) },
        () => { if (stallTimer) clearTimeout(stallTimer) },
      )
      return nativeOperation
    })

    return Promise.race([operation, stalled])
  }

  private sendLiveAudio(owner: LiveOwner, buffer: ArrayBuffer): void {
    if (!buffer.byteLength || !this.isLiveOwnerCurrent(owner) || owner.closing || owner.terminalError) return
    if (owner.pendingAudioBytes + buffer.byteLength > LIVE_PCM_BUDGET_BYTES) {
      this.failLiveOwner(owner, new Error(`Live ASR audio exceeded the ${LIVE_PCM_BUDGET_BYTES}-byte pending limit`))
      return
    }

    owner.operations.push({ kind: 'audio', buffer: buffer.slice(0), offset: 0 })
    owner.pendingAudioBytes += buffer.byteLength
    owner.audioFrontier += buffer.byteLength
    void this.startLiveDrain(owner)
  }

  private finalizeLive(owner: LiveOwner): Promise<void> {
    if (owner.terminalError) return Promise.reject(owner.terminalError)
    if (!this.isLiveOwnerCurrent(owner) || owner.closing) {
      return Promise.reject(new Error('Live ASR session is no longer accepting controls'))
    }

    const frontier = owner.audioFrontier
    if (owner.lastFinalize?.frontier === frontier) return owner.lastFinalize.promise
    if (owner.pendingFinalizeCount >= LIVE_CONTROL_QUEUE_LIMIT) {
      return Promise.reject(this.failLiveOwner(owner, new Error('Live ASR control queue limit exceeded')))
    }

    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise
      reject = rejectPromise
    })
    owner.operations.push({ kind: 'finalize', resolve, reject })
    owner.pendingFinalizeCount++
    owner.lastFinalize = { frontier, promise }
    void this.startLiveDrain(owner)
    return promise
  }

  private startLiveDrain(owner: LiveOwner): Promise<void> {
    if (owner.drainPromise) return owner.drainPromise
    const drainPromise = this.drainLiveOperations(owner)
    owner.drainPromise = drainPromise
    void drainPromise.then(() => {
      if (owner.drainPromise !== drainPromise) return
      owner.drainPromise = null
      if (owner.operations.length && !owner.terminalError) void this.startLiveDrain(owner)
    }, (error: unknown) => {
      if (owner.drainPromise !== drainPromise) return
      owner.drainPromise = null
      const wasTerminal = Boolean(owner.terminalError)
      this.failLiveOwner(owner, error)
      if (wasTerminal) {
        addRuntimeEvent('error', 'cloud_api', 'Live ASR operation drain failed after terminal error', {
          sessionId: owner.sessionId,
          error: String(error),
        })
      }
    })
    return drainPromise
  }

  private async drainLiveOperations(owner: LiveOwner): Promise<void> {
    while (!owner.terminalError) {
      const nextOperation = owner.operations[0]
      if (!nextOperation) return

      if (nextOperation.kind === 'finalize') {
        owner.operations.shift()
        try {
          await this.invokeLiveNative(
            owner,
            'deepgram_stream_finalize',
            { sessionId: owner.sessionId },
            LIVE_OPERATION_STALL_MS,
            () => {
              if (owner.terminalError) throw owner.terminalError
              if (this.liveOwner !== owner) throw new Error('Live ASR owner changed before Finalize')
              return true
            },
          )
          nextOperation.resolve()
        } catch (error) {
          nextOperation.reject(this.failLiveOwner(owner, error))
        } finally {
          owner.pendingFinalizeCount--
        }
        continue
      }

      const batch = this.takeLiveAudioBatch(owner)
      try {
        await this.invokeLiveNative(owner, 'deepgram_stream_send', {
          pcmB64: uint8ArrayToBase64(new Uint8Array(batch)),
          sessionId: owner.sessionId,
        }, LIVE_OPERATION_STALL_MS, () => {
          if (owner.terminalError) throw owner.terminalError
          if (this.liveOwner !== owner) throw new Error('Live ASR owner changed before audio send')
          return true
        })
      } catch (error) {
        this.failLiveOwner(owner, error)
      } finally {
        owner.pendingAudioBytes -= batch.byteLength
      }
    }
  }

  private takeLiveAudioBatch(owner: LiveOwner): ArrayBuffer {
    const parts: Uint8Array[] = []
    let totalBytes = 0
    while (totalBytes < LIVE_PCM_BATCH_BYTES) {
      const operation = owner.operations[0]
      if (!operation || operation.kind !== 'audio') break
      const availableBytes = operation.buffer.byteLength - operation.offset
      const batchBytes = Math.min(availableBytes, LIVE_PCM_BATCH_BYTES - totalBytes)
      parts.push(new Uint8Array(operation.buffer, operation.offset, batchBytes))
      operation.offset += batchBytes
      totalBytes += batchBytes
      if (operation.offset === operation.buffer.byteLength) owner.operations.shift()
    }

    const merged = new Uint8Array(totalBytes)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.byteLength
    }
    return merged.buffer
  }

  private failLiveOwner(owner: LiveOwner, cause: unknown): Error {
    const error = cause instanceof Error ? cause : new Error(String(cause))
    if (owner.terminalError) return owner.terminalError
    owner.terminalError = error
    let discardedAudioBytes = 0
    for (const operation of owner.operations.splice(0)) {
      if (operation.kind === 'audio') {
        discardedAudioBytes += operation.buffer.byteLength - operation.offset
      } else {
        owner.pendingFinalizeCount--
        operation.reject(error)
      }
    }
    owner.pendingAudioBytes -= discardedAudioBytes

    // Cleanup has its own result; a send failure cannot turn a successful close into a failed one.
    if (!owner.closing) {
      const liveError: LiveAsrError = {
        sessionId: owner.sessionId,
        message: error.message,
        asrEngine: owner.asrEngine,
        asrModel: owner.asrModel,
      }
      try {
        owner.callbacks.onError(liveError)
      } catch (callbackError) {
        addRuntimeEvent('error', 'cloud_api', 'Live ASR error callback failed', { error: String(callbackError) })
      }
    } else {
      addRuntimeEvent('warn', 'cloud_api', 'Live operation failed while closing', {
        sessionId: owner.sessionId, error: error.message,
      })
    }
    return error
  }

  private closeLiveOwner(owner: LiveOwner): Promise<void> {
    if (this.liveOwner !== owner) return Promise.resolve()
    if (owner.closePromise) return owner.closePromise

    owner.cancelled = true
    owner.closing = true
    // Resolving this promise confirms native cleanup. A timeout cannot release ownership.
    owner.closePromise = this.performLiveClose(owner).then(() => {
      if (this.liveOwner === owner) this.liveOwner = null
    }, (error: unknown) => {
      owner.closePromise = null
      throw error
    })
    return owner.closePromise
  }

  private async performLiveClose(owner: LiveOwner): Promise<void> {
    if (owner.nativeOpenOperation) {
      try {
        await owner.nativeOpenOperation
      } catch (error) {
        owner.nativeOpenError = error
      }
    }
    await this.startLiveDrain(owner)

    if (owner.nativeOpenAttempted) {
      await this.enqueueNativeLifecycle(() => invoke<void>('deepgram_stream_close', { sessionId: owner.sessionId }))
    }

    const unlistenErrors: unknown[] = []
    for (const unlisten of owner.unlisteners.splice(0)) {
      try {
        unlisten()
      } catch (error) {
        unlistenErrors.push(error)
      }
    }
    if (unlistenErrors.length) throw new Error(`Live ASR event cleanup failed: ${unlistenErrors.map(String).join('; ')}`)
  }


  // ── 豆包流式建连 ──

  private async tryStartRealtimeStream(
    runId: number,
    startOpts: Readonly<StartOptions>,
    profileSnapshot: Promise<AsrProfile | null>,
  ): Promise<void> {
    try {
      const profile = await profileSnapshot
      const asrProvider = profile?.provider ?? ''
      const qwenWorkspaceId = profile?.workspaceId ?? ''
      if (!this.isRunCurrent(runId)) return

      // 是否为本次会话开启「流式实时显示」：直接读设置（单一真源，避免录音器缓存过期），
      // 结合本次 start 快照兜底，并要求当前供应商在当前配置下真正就绪（qwen 需 WorkspaceId）。
      const settingOn = Boolean(await getSetting('streamingDisplayEnabled', false))
      if (!this.isRunCurrent(runId)) return
      const realtime = (settingOn || Boolean(startOpts.streamingDisplay)) && isStreamingDisplayReady(asrProvider, qwenWorkspaceId)
      addRuntimeEvent('info', 'cloud_api', 'Streaming display decision', { asrProvider, settingOn, startOpt: Boolean(startOpts.streamingDisplay), hasWorkspace: Boolean(qwenWorkspaceId), realtime, runId })
      if (realtime) {
        // 先订阅中间结果，避免建连后、订阅前丢帧
        await this.subscribePartials(runId)
        if (!this.isRunCurrent(runId)) return
      }

      if (asrProvider === 'doubao_v2') {
        // 豆包流式
        if (!profile) return
        this.isDoubaoStream = true
        const credentials = effectiveAsrCredentials(profile)

        addRuntimeEvent('info', 'cloud_api', 'Doubao streaming: connecting', { realtime })
        const open = await this.invokeNativeOpen(runId, 'doubao_stream_open', {
          config: { provider: 'doubao_v2', api_key: credentials.apiKey, app_id: credentials.appId },
          sampleRate: 16000,
          hotwords: startOpts.hotwords ?? [],
          realtime,
        })
        if (!open.opened || !this.isRunCurrent(runId)) return
        this.doubaoStreamReady = true
        addRuntimeEvent('info', 'cloud_api', 'Doubao streaming: ready')
      } else if (asrProvider === 'deepgram' && realtime && !startOpts.disableStreaming) {
        // Completed recordings use Deepgram's prerecorded HTTP endpoint. Only
        // live captions need a socket; segment consumers (computer subtitles)
        // set disableStreaming and take the HTTP route even when captions are on.
        if (!profile) return
        this.isDeepgramStream = true
        // Include audio captured before async profile resolution; subsequent
        // sendAudio calls append directly to this live queue.
        this.pendingChunks = this.pcmBuffers.slice()

        addRuntimeEvent('info', 'cloud_api', 'Deepgram streaming: connecting', { realtime })
        const open = await this.invokeNativeOpen(runId, 'deepgram_stream_open', {
          // The stream honors the same language payload as the buffered path, so an
          // explicit Russian/English choice is not lost when live captions are on.
          config: buildAsrProviderConfig(profile, normalizeSpeechInputLanguage(startOpts.language)),
          sampleRate: 16000,
          hotwords: startOpts.hotwords ?? [],
        })
        if (!open.opened || !this.isRunCurrent(runId)) return
        this.reportWarning(runId, open.payload)
        this.deepgramStreamReady = true
        addRuntimeEvent('info', 'cloud_api', 'Deepgram streaming: ready')
      } else if (isQwenStreamProvider(asrProvider) && realtime) {
        // 千问流式：只在开启实时显示、且这份配置真的就绪时才走流式 WebSocket。
        //   · qwen_realtime      需要 WorkspaceId（isStreamingDisplayReady 已把关）
        //   · qwen_audio_stream  不需要，填了密钥就能用
        // qwen3-asr-flash（非实时）与未开启实时显示时都不进此分支，走下面的一次性识别。
        this.isQwenStream = true
        this.qwenCommands = QWEN_STREAM_COMMANDS[asrProvider]
        if (!profile) return
        const credentials = effectiveAsrCredentials(profile)

        addRuntimeEvent('info', 'cloud_api', 'Qwen streaming: connecting', { asrProvider, hasWorkspace: Boolean(qwenWorkspaceId) })
        const open = await this.invokeNativeOpen(runId, this.qwenCommands.open, {
          config: { provider: asrProvider, api_key: credentials.apiKey, app_id: '' },
          hotwords: startOpts.hotwords ?? [],
          realtime,
          workspaceId: qwenWorkspaceId,
        })
        if (!open.opened || !this.isRunCurrent(runId)) return
        this.qwenStreamReady = true
        addRuntimeEvent('info', 'cloud_api', 'Qwen streaming: ready', { asrProvider })
      } else {
        // 其他情况（含未配置 WorkspaceId 的千问）走录完再发的一次性识别
        this.teardownPartials()
        return
      }

      // 补发建连期间已缓存的音频
      await this.flushPendingChunks(runId)
      if (!this.isRunCurrent(runId)) return

      // 启动定时器，每 200ms 批量发送一次（收尾阶段不再触发新发送）
      this.flushTimer = setInterval(() => {
        if (!this.isRunCurrent(runId) || this.streamFinishing) return
        const ready = this.doubaoStreamReady || this.qwenStreamReady || this.deepgramStreamReady
        if (ready && this.pendingChunks.length > 0) {
          void this.flushPendingChunks(runId)
        }
      }, 200)
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      if (errorProtocolCode(err) === 'deepgram_keyterm_retry_failed') {
        this.streamOpenFailure = { runId, error: String(err) }
        this.teardownPartials()
        return
      }
      addRuntimeEvent('warn', 'cloud_api', 'Streaming connection failed; falling back to buffered upload', { error: String(err) })
      this.isDoubaoStream = false
      this.isQwenStream = false
      this.isDeepgramStream = false
      this.doubaoStreamReady = false
      this.qwenStreamReady = false
      this.deepgramStreamReady = false
      this.qwenCommands = null
      this.teardownPartials()
    }
  }

  /** 把一次批量发送排入串行链路，返回可 await 的 Promise。
   *  链式串行保证多次 flush、以及收尾前的最终 flush 都严格按顺序送达 Rust，
   *  绝不会出现音频包穿插到负包之后。 */
  private flushPendingChunks(runId: number): Promise<void> {
    const run = async () => {
      if (!this.isRunCurrent(runId) || this.pendingChunks.length === 0) return
      const chunks = this.pendingChunks
      this.pendingChunks = []

      const totalLen = chunks.reduce((s, c) => s + c.byteLength, 0)
      const merged = new Uint8Array(totalLen)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(new Uint8Array(chunk), offset)
        offset += chunk.byteLength
      }

      const b64 = uint8ArrayToBase64(merged)
      try {
        if (this.isDoubaoStream) {
          await invoke('doubao_stream_send', { pcmB64: b64 })
        } else if (this.isDeepgramStream) {
          await invoke('deepgram_stream_send', { pcmB64: b64 })
        } else if (this.isQwenStream && this.qwenCommands) {
          await invoke(this.qwenCommands.send, { pcmB64: b64 })
        }
      } catch (err) {
        addRuntimeEvent('warn', 'cloud_api', 'Streaming send failed', { error: String(err) })
        // A dropped frame cannot be recovered on the socket. Stop streaming so the
        // stop path re-transcribes the retained full recording through Deepgram's
        // prerecorded endpoint instead of returning a partial transcript.
        if (this.isDeepgramStream) this.deepgramStreamReady = false
      }
    }
    // 接到发送链尾部，串行执行（无论前一个成功或失败都继续）
    this.sendLock = this.sendLock.then(run, run)
    return this.sendLock
  }

  // ── 处理逻辑 ──

  private async runProcess(
    runId: number,
    startOpts: Readonly<StartOptions>,
    profileSnapshot: Promise<AsrProfile | null>,
  ): Promise<void> {
    const stopTime = performance.now() // stop 时刻，用于计算流式模式的等待时间
    const startTime = this.streamStartTime || stopTime

    try {
      if (!this.isRunCurrent(runId)) return
      const totalBytes = this.pcmBuffers.reduce((sum, buf) => sum + buf.byteLength, 0)
      if (totalBytes === 0) {
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      const durationSec = (totalBytes / 2) / 16000
      if (durationSec < 0.3) {
        addRuntimeEvent('info', 'cloud_api', 'Audio too short; skipped processing', { durationSec })
        this.teardownPartials()
        this.callbacks.onDone?.()
        return
      }

      const profile = await profileSnapshot
      if (!profile) throw new Error('No active cloud ASR profile')
      if (!this.isRunCurrent(runId)) return
      const asrProvider = profile.provider
      const isQwenOmni = isQwenOmniProvider(asrProvider)
      // Stamp every result with the model this run's request snapshot actually used.
      // Consumers (history, reprocessing) must never re-read the active profile: it
      // can be switched while a recognition is still in flight.
      const { engine: requestEngine, model: requestModel } = resolveAsrRequestMetadata(profile)

      if (awaitsDeepgramKeytermStartup(profile, startOpts)) {
        await this.streamStartup
        if (!this.isRunCurrent(runId)) return
      }
      if (this.streamOpenFailure?.runId === runId) throw this.streamOpenFailure.error

      let asrText = ''
      let asrMs = 0

      // Finish: set the finishing flag first (no new audio may enter the queue and
      // the timer stops), flush what is left and drain the send chain, so the
      // CloseStream frame is the last one on the wire. If the final flush fails on
      // the Deepgram socket, the branch below re-decides on readiness and falls
      // back to the buffered HTTP path with the retained full recording.
      this.streamFinishing = true
      if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
      await this.flushPendingChunks(runId)
      await this.sendLock
      if (!this.isRunCurrent(runId)) return

      if ((this.isDoubaoStream && this.doubaoStreamReady) || (this.isDeepgramStream && this.deepgramStreamReady) || (this.isQwenStream && this.qwenStreamReady)) {
        if (this.isDoubaoStream) {
          addRuntimeEvent('info', 'cloud_api', 'Doubao streaming: sending finish')
          const finishStart = performance.now()
          const text = await this.invokeNativeFinish(runId, 'doubao_stream_finish')
          if (text === undefined || !this.isRunCurrent(runId)) return
          asrText = text
          asrMs = Math.round(performance.now() - finishStart)
          addRuntimeEvent('info', 'cloud_api', 'Doubao streaming: recognition complete', { asrMs, textLen: asrText.length })
        } else if (this.isDeepgramStream) {
          addRuntimeEvent('info', 'cloud_api', 'Deepgram streaming: sending finish')
          const finishStart = performance.now()
          const text = await this.invokeNativeFinish(runId, 'deepgram_stream_finish')
          if (text === undefined || !this.isRunCurrent(runId)) return
          asrText = text
          asrMs = Math.round(performance.now() - finishStart)
          addRuntimeEvent('info', 'cloud_api', 'Deepgram streaming: recognition complete', { asrMs, textLen: asrText.length })
        } else {
          // 命令组在 qwenStreamReady 之前就已赋值，这里只是让类型收窄；
          // 真为空就抛出去，而不是悄悄返回空文本（空结果会被显示成「没听到声音」）。
          const commands = this.qwenCommands
          if (!commands) throw new Error('Qwen streaming session has no native command set')
          addRuntimeEvent('info', 'cloud_api', 'Qwen streaming: sending finish', { command: commands.finish })
          const finishStart = performance.now()
          const text = await this.invokeNativeFinish(runId, commands.finish)
          if (text === undefined || !this.isRunCurrent(runId)) return
          asrText = text
          asrMs = Math.round(performance.now() - finishStart)
          addRuntimeEvent('info', 'cloud_api', 'Qwen streaming: recognition complete', { asrMs, textLen: asrText.length })
        }
      } else {
        // 非豆包 / 豆包建连失败：录完再发
        const merged = new Uint8Array(totalBytes)
        let offset = 0
        for (const buf of this.pcmBuffers) {
          merged.set(new Uint8Array(buf), offset)
          offset += buf.byteLength
        }
        const audioB64 = uint8ArrayToBase64(merged)

        const asrConfig: AsrProviderConfig = buildAsrProviderConfig(
          profile,
          normalizeSpeechInputLanguage(startOpts.language),
        )

        addRuntimeEvent('info', 'cloud_api', 'ASR started', { provider: asrProvider, durationSec })
        const asrResult = asrProvider === CUSTOM_ASR_PROVIDER
          ? await transcribeCustomAsr({
            profile,
            audioB64,
            sampleRate: 16000,
            language: normalizeSpeechInputLanguage(startOpts.language),
            hotwords: startOpts.hotwords ?? [],
            isCurrent: () => this.isRunCurrent(runId),
          })
          : await invoke<AsrResult>('cloud_transcribe', {
            request: {
              audio_b64: audioB64,
              sample_rate: 16000,
              asr_config: asrConfig,
              hotwords: startOpts.hotwords ?? [],
            },
          })
        if (!this.isRunCurrent(runId) || !asrResult) return
        if ('warning' in asrResult) this.reportWarning(runId, asrResult.warning)
        asrText = asrResult.text
        asrMs = asrResult.elapsed_ms
      }

      this.pcmBuffers = []
      // ASR 已拿到最终文本，后续不再有中间结果，撤下监听
      this.teardownPartials()

      // 还原被 ASR 拆开加空格的无空格热词（如豆包把 "SayIt" 识别成 "Say It"）
      asrText = restoreHotwordSpacing(asrText, startOpts.hotwords ?? [])

      // 发送 ASR 中间结果
      this.callbacks.onASR?.({
        text: asrText,
        asrMs,
        durationSec,
        ...(this.asrWarning && { asrWarning: this.asrWarning }),
        ...(!asrText.trim() && requestModel && {
          asrEngine: requestEngine,
          asrModel: requestModel,
        }),
      })

      if (!asrText.trim()) {
        this.callbacks.onFinal?.({
          asrText: '',
          llmText: '',
          asrMs,
          llmMs: 0,
          durationSec,
          ...(this.asrWarning && { asrWarning: this.asrWarning }),
          ...(requestModel && {
            asrEngine: requestEngine,
            asrModel: requestModel,
          }),
        })
        this.callbacks.onDone?.()
        return
      }

      // Omni normally provides its own cleanup; subtitles still need the requested translation stage.
      const polish = isQwenOmni && !startOpts.requireTranslation
        ? {
          llmText: startOpts.textContext?.selectedText || asrText,
          llmMs: 0,
          contextApplied: startOpts.textContext ? false : undefined,
          aiSource: 'none' as const,
          aiStatus: 'skipped' as const,
        }
        : await polishWithClientAi({
          asrText,
          durationSec,
          startOptions: startOpts,
          logSource: 'cloud_api',
          isCurrent: () => this.isRunCurrent(runId),
        })
      if (!polish || !this.isRunCurrent(runId)) return

      const totalMs = Math.round(performance.now() - startTime)
      addRuntimeEvent('info', 'cloud_api', 'Processing complete', {
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
        ...(this.asrWarning && { asrWarning: this.asrWarning }),
        ...polish,
        ...(requestModel && { asrEngine: requestEngine, asrModel: requestModel }),
      })
      this.callbacks.onDone?.()
    } catch (err) {
      if (!this.isRunCurrent(runId)) return
      addRuntimeEvent('error', 'cloud_api', 'Processing failed', { error: String(err) })
      this.teardownPartials()
      this.callbacks.onError?.(String(err))
      this.callbacks.onDone?.()
    } finally {
      this.completeRun(runId)
    }
  }
}

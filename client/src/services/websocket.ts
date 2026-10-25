// WebSocket service for communicating with SayIt backend

import {
  addMsg,
  addAudioChunk,
  startSession,
  endSession,
  addRuntimeEvent,
  hasActiveSession,
} from './debugLog'
import { getWSUrl, serverNotConfiguredMessage } from './runtimeConfig'
import { withLegacyServerTextContext } from './contextAware'
import { normalizeServerLlmDebug, type ServerLlmEvidence } from './transcription/aiOutcome'
import { setConnectionStatus } from '../stores/connectionStatus'
import type { ActiveAppContext, TextContext } from '../types/appContext'
import type { ClientRuntimeInfo } from '../types/appApi'

export type WSState = 'disconnected' | 'connecting' | 'connected' | 'error'

export interface ASRResult {
  text: string
  asrMs: number
  durationSec: number
}

export interface FinalResult {
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  asrEngine?: string
  asrModel?: string
  contextApplied?: boolean
  /** Content-free projection of the server's llm_debug; absent when an older server sent none. */
  llmDebug?: ServerLlmEvidence
}

export interface AudioStats {
  avgRms: number
  peakRms: number
  peakAmplitude: number
  silenceRatio: number
  totalFrames: number
}

export interface WSCallbacks {
  onStateChange?: (state: WSState) => void
  onReady?: (data: { connectionId: string; asr: boolean; llm: boolean }) => void
  onASR?: (result: ASRResult) => void
  onFinal?: (result: FinalResult) => void
  onDone?: () => void
  onError?: (msg: string) => void
}

let ws: WebSocket | null = null
let callbacks: WSCallbacks = {}
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let intentionalClose = false
/** Timestamp of when the connection was established, used in logs to compute connection lifetime */
let connectStartMs = 0
let openedAtMs = 0

/** Captures a short call stack (dropping this function's own frame and the Error header lines), used in logs to pinpoint who triggered the connection/close. */
function shortCallerStack(): string {
  const raw = new Error().stack || ''
  return raw
    .split('\n')
    .slice(2, 5)
    .map((l) => l.trim().replace(/^at\s+/, ''))
    .join(' <- ')
}

// --- Reconnect backoff ---
let reconnectAttempts = 0
const RECONNECT_BASE_MS = 3000
const RECONNECT_MAX_MS = 30_000
// Server throttling close codes (1013 server full, 4029 concurrent limit exceeded for this IP): back off longer to avoid a reconnect storm
const RECONNECT_LIMIT_MIN_MS = 15_000
const LIMIT_CLOSE_CODES = new Set([1013, 4029])

/** Computes the next reconnect delay: exponential backoff with ±20% jitter; for throttling close codes, backs off at least RECONNECT_LIMIT_MIN_MS */
function computeReconnectDelayMs(closeCode?: number): number {
  const exp = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempts, RECONNECT_MAX_MS)
  const base = closeCode !== undefined && LIMIT_CLOSE_CODES.has(closeCode)
    ? Math.max(exp, RECONNECT_LIMIT_MIN_MS)
    : exp
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  return Math.max(1000, Math.round(base + jitter))
}
let sessionStarted = false
let audioDropWarned = false
/** Advertised by new servers in the ready message. Missing means a rolling-upgrade legacy server. */
let serverSupportsTextContext = false
/** Whether the current request placed a compatibility capsule in system_prompt. */
let legacyTextContextForSession = false

// --- Heartbeat ---
const HEARTBEAT_INTERVAL_MS = 30_000
const HEARTBEAT_TIMEOUT_MS = 10_000
let heartbeatTimer: ReturnType<typeof setInterval> | null = null
let pongTimer: ReturnType<typeof setTimeout> | null = null

function startHeartbeat() {
  stopHeartbeat()
  heartbeatTimer = setInterval(() => {
    if (ws?.readyState !== WebSocket.OPEN) return
    try {
      ws.send(JSON.stringify({ cmd: 'ping' }))
      // Start pong timeout
      pongTimer = setTimeout(() => {
        addRuntimeEvent('warn', 'websocket', 'Heartbeat timed out: no pong for 10s; disconnecting')
        // Force close so onclose triggers reconnect
        try { ws?.close(4000, 'heartbeat timeout') } catch { /* ignore */ }
      }, HEARTBEAT_TIMEOUT_MS)
    } catch {
      // send failed, connection is likely dead
      try { ws?.close(4000, 'heartbeat send failed') } catch { /* ignore */ }
    }
  }, HEARTBEAT_INTERVAL_MS)
}

function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
}

function handlePong() {
  if (pongTimer) { clearTimeout(pongTimer); pongTimer = null }
}

function updateGlobalState(state: WSState) {
  setConnectionStatus(state)
  callbacks.onStateChange?.(state)
}

// HMR cleanup: close WebSocket when module is hot-replaced
if ((import.meta as unknown as Record<string, unknown>).hot) {
  const hot = (import.meta as unknown as Record<string, unknown>).hot as { dispose: (cb: () => void) => void }
  hot.dispose(() => {
    console.log('[websocket] HMR dispose: closing WebSocket')
    intentionalClose = true
    stopHeartbeat()
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    try { ws?.close() } catch { /* ignore */ }
    ws = null
    serverSupportsTextContext = false
    sessionStarted = false
    legacyTextContextForSession = false
  })
}

function endSessionIfNeeded() {
  if (sessionStarted || hasActiveSession()) {
    sessionStarted = false
    endSession()
  }
  audioDropWarned = false
  legacyTextContextForSession = false
}

export function connect(cbs: WSCallbacks): Promise<void> {
  callbacks = cbs

  if (ws?.readyState === WebSocket.OPEN) {
    // Already connected, reuse it directly (connect is idempotent). This is the normal path on every recording start, so nothing is logged to avoid flooding the log;
    // truly abnormal connection scenarios are covered by logs such as connect start, connect success, intentional close, and closing a not-yet-ready connection.
    return Promise.resolve()
  }

  if (ws) {
    // The previous connection is still around (it may still be CONNECTING, or just opened but not yet marked ready). It is proactively closed here before reconnecting;
    // this is exactly the most likely culprit behind "connected for a few seconds, then closed by itself without ever sending start", so it is recorded to see who triggered it.
    const prevState = ws.readyState
    addRuntimeEvent('warn', 'websocket', 'connect() closed the previous unready connection before reconnecting', {
      prevReadyState: prevState, // 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
      caller: shortCallerStack(),
    })
    intentionalClose = true
    try {
      ws.close()
    } catch {
      // ignore
    }
    ws = null
  }

  return new Promise((resolve, reject) => {
    intentionalClose = false
    serverSupportsTextContext = false
    updateGlobalState('connecting')
    const wsUrl = getWSUrl()
    if (!wsUrl) {
      updateGlobalState('error')
      addRuntimeEvent('error', 'websocket', 'No server address is configured')
      reject(new Error(serverNotConfiguredMessage()))
      return
    }
    connectStartMs = Date.now()
    addRuntimeEvent('info', 'websocket', 'Connecting', { url: wsUrl, caller: shortCallerStack() })

    const socket = new WebSocket(wsUrl)
    socket.binaryType = 'arraybuffer'
    ws = socket

    const timeout = setTimeout(() => {
      if (socket.readyState !== WebSocket.OPEN) {
        try {
          socket.close()
        } catch {
          // ignore
        }
        updateGlobalState('error')
        addRuntimeEvent('error', 'websocket', 'Connection timed out (10s)', { url: wsUrl })
        reject(new Error('WebSocket connection timeout'))
      }
    }, 10000)

    socket.onopen = () => {
      clearTimeout(timeout)
      openedAtMs = Date.now()
      updateGlobalState('connected')
      const wasReconnect = reconnectAttempts > 0
      addRuntimeEvent('info', 'websocket', wasReconnect ? `Reconnected on attempt ${reconnectAttempts}` : 'Connected', {
        elapsedMs: connectStartMs ? openedAtMs - connectStartMs : undefined,
      })
      reconnectAttempts = 0
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      startHeartbeat()
      resolve()
    }

    socket.onmessage = (e) => {
      // A stale socket already replaced by cancel/disconnect must never deliver
      // its queued messages to the new session's callbacks, even if messages remain in the queue.
      if (ws !== socket) return
      if (typeof e.data !== 'string') return
      try {
        const msg = JSON.parse(e.data)
        addMsg('received', msg.type || 'unknown', msg)

        switch (msg.type) {
          case 'ready':
            serverSupportsTextContext = msg?.capabilities?.text_context === true
            addRuntimeEvent('info', 'websocket', 'Ready received', {
              connectionId: msg.connection_id,
              asr: msg.asr,
              llm: msg.llm,
              textContext: serverSupportsTextContext,
            })
            callbacks.onReady?.({
              connectionId: msg.connection_id,
              asr: msg.asr,
              llm: msg.llm,
            })
            break
          case 'pong':
            handlePong()
            break
          case 'asr':
            callbacks.onASR?.({
              text: msg.text,
              asrMs: msg.asr_ms,
              durationSec: Number(msg.duration_sec || 0),
            })
            break
          case 'final': {
            const durationFromAsrDebug = Number(msg?.asr_debug?.duration_sec || 0)
            const explicitContextApplied = typeof msg.context_applied === 'boolean'
              ? msg.context_applied
              : undefined
            const legacyContextApplied = explicitContextApplied === undefined
              && legacyTextContextForSession
              && Boolean(msg?.llm_debug?.provider)
            callbacks.onFinal?.({
              asrText: msg.asr_text,
              llmText: msg.llm_text,
              asrMs: msg.asr_ms,
              llmMs: msg.llm_ms,
              durationSec: Number(msg.duration_sec || durationFromAsrDebug || 0),
              asrEngine: msg.asr_engine || undefined,
              asrModel: msg.asr_model || undefined,
              contextApplied: explicitContextApplied ?? (legacyContextApplied ? true : undefined),
              llmDebug: normalizeServerLlmDebug(msg?.llm_debug),
            })
            break
          }
          case 'done':
            endSessionIfNeeded()
            callbacks.onDone?.()
            break
          case 'error':
            addRuntimeEvent('error', 'backend', String(msg.message || 'unknown backend error'), msg)
            endSessionIfNeeded()
            callbacks.onError?.(String(msg.message || 'unknown backend error'))
            break
        }
      } catch (err) {
        addRuntimeEvent('error', 'websocket', 'Message parsing failed', {
          error: String(err),
          raw: e.data,
        })
      }
    }

    socket.onerror = (ev) => {
      if (ws !== socket) return
      clearTimeout(timeout)
      updateGlobalState('error')
      addRuntimeEvent('error', 'websocket', 'Connection error', {
        event: String(ev.type || 'error'),
      })
    }

    socket.onclose = (ev) => {
      clearTimeout(timeout)
      if (ws !== socket) {
        addRuntimeEvent('info', 'websocket', 'Ignored close event from stale connection', { code: ev.code })
        return
      }
      stopHeartbeat()
      ws = null
      serverSupportsTextContext = false
      updateGlobalState('disconnected')

      const aliveMs = openedAtMs ? Date.now() - openedAtMs : undefined
      const sentStart = sessionStarted
      endSessionIfNeeded()

      if (!intentionalClose) {
        const delay = computeReconnectDelayMs(ev.code)
        addRuntimeEvent('warn', 'websocket', `Connection closed code=${ev.code} reason=${ev.reason || '-'}; reconnecting in ${Math.round(delay / 1000)}s`, {
          code: ev.code,
          attempt: reconnectAttempts + 1,
          aliveMs,
          sentStart,
        })
        reconnectAttempts++
        reconnectTimer = setTimeout(() => connect(callbacks), delay)
      } else {
        // Client-initiated closes used to be completely silent (switching provider/address, connect() replacing an old connection, disconnect()).
        // They now also log one line marking the close as client-initiated, to tell a server kick apart from the client closing on its own.
        addRuntimeEvent('warn', 'websocket', `Connection closed intentionally code=${ev.code} reason=${ev.reason || '-'}`, {
          code: ev.code,
          aliveMs,
          sentStart,
          caller: shortCallerStack(),
        })
      }
      openedAtMs = 0
    }
  })
}

export function disconnect() {
  addRuntimeEvent('info', 'websocket', 'disconnect() called', {
    hadSocket: !!ws,
    readyState: ws?.readyState,
    caller: shortCallerStack(),
  })
  intentionalClose = true
  reconnectAttempts = 0
  stopHeartbeat()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const socket = ws
  ws = null
  serverSupportsTextContext = false
  try {
    socket?.close()
  } catch {
    // ignore
  }
  updateGlobalState('disconnected')
  endSessionIfNeeded()
}

export function sendStart(opts?: {
  systemPrompt?: string
  disableAi?: boolean
  clientMeta?: ClientRuntimeInfo | null
  appContext?: ActiveAppContext | null
  textContext?: TextContext | null
  source?: string
  hotwords?: string[]
  language?: string
}): boolean {
  if (ws?.readyState !== WebSocket.OPEN) {
    addRuntimeEvent('error', 'websocket', 'Failed to send start: connection not ready')
    return false
  }

  const msg: Record<string, unknown> = { cmd: 'start', source: opts?.source || 'live' }
  legacyTextContextForSession = Boolean(opts?.textContext && !serverSupportsTextContext)
  const effectiveSystemPrompt = legacyTextContextForSession && opts?.systemPrompt && opts.textContext
    ? withLegacyServerTextContext(opts.systemPrompt, opts.textContext)
    : opts?.systemPrompt
  if (effectiveSystemPrompt) msg.system_prompt = effectiveSystemPrompt
  if (opts?.disableAi) msg.disable_ai = true
  if (opts?.clientMeta) {
    msg.client_meta = {
      user_id: opts.clientMeta.userId,
      device_id: opts.clientMeta.deviceId,
      hostname: opts.clientMeta.hostname,
      client_version: opts.clientMeta.clientVersion,
      platform: opts.clientMeta.platform,
      os_version: opts.clientMeta.osVersion,
      local_ip: opts.clientMeta.localIp,
      system_locale: opts.clientMeta.systemLocale,
      cpu_cores: opts.clientMeta.cpuCores,
      memory_mb: opts.clientMeta.memoryMb,
    }
  }
  if (opts?.appContext) {
    msg.app_context = {
      process_name: opts.appContext.processName,
      exe_path: opts.appContext.exePath,
      window_class: opts.appContext.windowClass,
      focus_class: opts.appContext.focusClass,
      control_type: opts.appContext.controlType,
    }
  }
  if (opts?.textContext) {
    msg.text_context = {
      source: opts.textContext.source,
      text_before: opts.textContext.textBefore,
      selected_text: opts.textContext.selectedText,
      text_after: opts.textContext.textAfter,
      selection_truncated: opts.textContext.selectionTruncated,
    }
  }
  if (opts?.hotwords && opts.hotwords.length > 0) {
    msg.hotwords = opts.hotwords
  }
  if (opts?.language) {
    msg.language = opts.language
  }

  try {
    startSession(opts)
    // Never persist editor text through the compatibility system prompt. The wire request uses the
    // effective prompt; diagnostics retain the original content-free prompt plus bounded lengths.
    addMsg('sent', 'start', legacyTextContextForSession
      ? { ...msg, system_prompt: opts?.systemPrompt }
      : msg)
    if (legacyTextContextForSession) {
      addRuntimeEvent('warn', 'websocket', 'Using legacy server text-context compatibility', {
        source: opts?.textContext?.source,
        beforeLen: opts?.textContext?.textBefore.length,
        selectedLen: opts?.textContext?.selectedText.length,
        afterLen: opts?.textContext?.textAfter.length,
      })
    }
    ws.send(JSON.stringify(msg))
    sessionStarted = true
    audioDropWarned = false
    return true
  } catch (err) {
    addRuntimeEvent('error', 'websocket', 'Failed to send start', { error: String(err) })
    endSessionIfNeeded()
    return false
  }
}

export function sendStop(opts?: {
  pttHoldMs?: number
  /** The "skip AI for this turn" flag, applied on key release. The server only starts ASR+AI after receiving stop, so there is still time to apply it. */
  disableAi?: boolean
  audioStats?: AudioStats
}): boolean {
  if (!sessionStarted) {
    return false
  }

  if (ws?.readyState !== WebSocket.OPEN) {
    addRuntimeEvent('error', 'websocket', 'Failed to send stop: connection not ready')
    endSessionIfNeeded()
    return false
  }

  try {
    const payload: Record<string, unknown> = { cmd: 'stop' }
    if (typeof opts?.pttHoldMs === 'number' && Number.isFinite(opts.pttHoldMs)) {
      payload.usage_meta = { ptt_hold_ms: Math.max(0, Math.round(opts.pttHoldMs)) }
    }
    if (opts?.disableAi) payload.disable_ai = true
    if (opts?.audioStats) {
      payload.audio_stats = {
        avg_rms: opts.audioStats.avgRms,
        peak_rms: opts.audioStats.peakRms,
        peak_amplitude: opts.audioStats.peakAmplitude,
        silence_ratio: opts.audioStats.silenceRatio,
        total_frames: opts.audioStats.totalFrames,
      }
    }
    addMsg('sent', 'stop', payload)
    ws.send(JSON.stringify(payload))
    return true
  } catch (err) {
    addRuntimeEvent('error', 'websocket', 'Failed to send stop', { error: String(err) })
    endSessionIfNeeded()
    return false
  }
}

export function sendAudio(buffer: ArrayBuffer) {
  if (!sessionStarted) {
    return
  }

  if (ws?.readyState === WebSocket.OPEN) {
    audioDropWarned = false
    try {
      ws.send(buffer)
      addAudioChunk(buffer)
    } catch (err) {
      addRuntimeEvent('error', 'websocket', 'Failed to send audio', {
        error: String(err),
        bytes: buffer.byteLength,
      })
    }
    return
  }

  if (!audioDropWarned) {
    audioDropWarned = true
    addRuntimeEvent('warn', 'websocket', 'Audio discarded: connection is closed', { bytes: buffer.byteLength })
  }
}

export function isConnected(): boolean {
  return ws?.readyState === WebSocket.OPEN
}

/** True once the connected server advertised text_context; false for legacy servers and while disconnected. */
export function supportsTextContext(): boolean {
  return serverSupportsTextContext
}

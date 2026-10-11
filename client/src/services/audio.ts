// Audio capture service — AudioWorklet with ScriptProcessorNode fallback.
// WebView2 on Windows has known issues where AudioWorklet's process() never
// fires despite addModule() succeeding.  We detect this and fall back to the
// deprecated-but-reliable ScriptProcessorNode.

import { PCMResampler } from '../../../server/web/pcm-processor.js'
import pcmProcessorSource from '../../../server/web/pcm-processor.js?raw'
import { addRuntimeEvent } from './debugLog'
import { DEFAULT_MIC_BOOST, resolveMicBoost } from './defaults'
import { getSetting } from './store'

let audioCtx: AudioContext | null = null
let workletNode: AudioWorkletNode | null = null
let scriptNode: ScriptProcessorNode | null = null
let mediaStream: MediaStream | null = null
let sourceNode: MediaStreamAudioSourceNode | null = null
let gainNode: GainNode | null = null
let onAudioData: ((buffer: ArrayBuffer) => void) | null = null
let onVolumeChange: ((volume: number) => void) | null = null
let onPCMFrame: ((pcm: Int16Array) => void) | null = null
let actualSampleRate = 16000
let firstPCMFrameLogged = false
let firstRmsLogged = false
let usingFallback = false

const TARGET_SAMPLE_RATE = 16000

/** The microphone endpoint that getUserMedia actually opened. */
export interface ActiveMicrophoneInfo {
  deviceId: string
  groupId: string
  label: string
}

// HMR cleanup: tear down audio capture when module is hot-replaced
if ((import.meta as unknown as Record<string, unknown>).hot) {
  const hot = (import.meta as unknown as Record<string, unknown>).hot as { dispose: (cb: () => void) => void }
  hot.dispose(() => {
    console.log('[audio] HMR dispose: tearing down audio capture')
    if (workletNode) {
      try { workletNode.port.onmessage = null } catch { /* ignore */ }
      try { workletNode.disconnect() } catch { /* ignore */ }
      workletNode = null
    }
    if (scriptNode) {
      try { scriptNode.onaudioprocess = null } catch { /* ignore */ }
      try { scriptNode.disconnect() } catch { /* ignore */ }
      scriptNode = null
    }
    if (gainNode) {
      try { gainNode.disconnect() } catch { /* ignore */ }
      gainNode = null
    }
    if (sourceNode) {
      try { sourceNode.disconnect() } catch { /* ignore */ }
      sourceNode = null
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach((track) => track.stop())
      mediaStream = null
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => { })
    }
    audioCtx = null
    onAudioData = null
    onVolumeChange = null
    onPCMFrame = null
  })
}

export function getActualSampleRate(): number {
  return actualSampleRate
}

const PCM_WORKLET_CODE = `${pcmProcessorSource}\nregisterPCMProcessor();`

export async function listMicrophones(): Promise<MediaDeviceInfo[]> {
  const audioInputs = (list: MediaDeviceInfo[]) => list.filter((d) => d.kind === 'audioinput')

  let devices = audioInputs(await navigator.mediaDevices.enumerateDevices())

  // Without persistent microphone permission, enumerateDevices() returns only an
  // unnamed generic entry. Open a temporary stream to request permission, then
  // enumerate while it is active to obtain the real device names.
  if (devices.length <= 1 || devices.some((d) => !d.label)) {
    let stream: MediaStream | null = null
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      devices = audioInputs(await navigator.mediaDevices.enumerateDevices())
    } catch {
      // Permission denied or no microphone available: keep the existing results.
    } finally {
      if (stream) stream.getTracks().forEach((t) => t.stop())
    }
  }

  return devices
}

function createAudioContext() {
  const AudioContextCtor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) {
    throw new Error('Current browser does not support AudioContext')
  }
  // Prefer a 16 kHz AudioContext so the browser's high-quality resampler handles
  // conversion and our linear interpolation can be skipped. Linear interpolation
  // has no anti-aliasing low-pass filter: 48k-to-16k downsamples by a factor of 3,
  // folding energy from 8-24 kHz into 0-8 kHz and directly harming ASR accuracy.
  // Not every WebView2/browser accepts the sampleRate option; otherwise fall back
  // to the original context creation path.
  for (const opts of [
    { latencyHint: 'interactive', sampleRate: TARGET_SAMPLE_RATE, sinkId: { type: 'none' } },
    { latencyHint: 'interactive', sampleRate: TARGET_SAMPLE_RATE },
    { latencyHint: 'interactive', sinkId: { type: 'none' } },
    { latencyHint: 'interactive' },
  ] as unknown as AudioContextOptions[]) {
    try {
      return new AudioContextCtor(opts)
    } catch {
      // This option combination is unsupported; try the next one.
    }
  }
  return new AudioContextCtor()
}

async function teardownCapture() {
  if (workletNode) {
    try { workletNode.port.onmessage = null } catch { /* ignore */ }
    try { workletNode.disconnect() } catch { /* ignore */ }
    workletNode = null
  }

  if (scriptNode) {
    try { scriptNode.onaudioprocess = null } catch { /* ignore */ }
    try { scriptNode.disconnect() } catch { /* ignore */ }
    scriptNode = null
  }

  if (gainNode) {
    try { gainNode.disconnect() } catch { /* ignore */ }
    gainNode = null
  }

  if (sourceNode) {
    try { sourceNode.disconnect() } catch { /* ignore */ }
    sourceNode = null
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop())
    mediaStream = null
  }

  if (audioCtx && audioCtx.state !== 'closed') {
    await audioCtx.close().catch(() => { })
  }
  audioCtx = null
  actualSampleRate = TARGET_SAMPLE_RATE
}

/** Wire up ScriptProcessorNode as fallback when AudioWorklet fails */
function setupScriptProcessorFallback(ctx: AudioContext, src: AudioNode) {
  usingFallback = true
  const resampler = new PCMResampler(ctx.sampleRate, TARGET_SAMPLE_RATE)
  actualSampleRate = TARGET_SAMPLE_RATE

  // Disconnect worklet if it was connected
  if (workletNode) {
    try { workletNode.port.onmessage = null } catch { /* ignore */ }
    try { workletNode.disconnect() } catch { /* ignore */ }
    try { src.disconnect(workletNode) } catch { /* ignore */ }
    workletNode = null
  }

  // 4096 samples buffer — good balance between latency and efficiency
  const spn = ctx.createScriptProcessor(4096, 1, 1)
  scriptNode = spn

  let totalPCMBytes = 0
  let totalPCMFrames = 0
  let captureStartTime = performance.now()

  spn.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const { pcm, rms } = resampler.process(input)

    if (!firstRmsLogged && rms > 0) {
      firstRmsLogged = true
      addRuntimeEvent('info', 'audio', 'First RMS received (ScriptProcessor)', {
        rms: Number(rms.toFixed(6)),
        sampleRate: TARGET_SAMPLE_RATE,
      })
    }
    onVolumeChange?.(rms)

    if (pcm.length > 0) {
      const pcmBuffer = pcm.buffer as ArrayBuffer
      totalPCMBytes += pcmBuffer.byteLength
      totalPCMFrames++

      if (!firstPCMFrameLogged) {
        firstPCMFrameLogged = true
        captureStartTime = performance.now()
        let peak = 0
        for (let i = 0; i < pcm.length; i++) {
          const value = Math.abs(pcm[i])
          if (value > peak) peak = value
        }
      addRuntimeEvent('info', 'audio', 'First PCM frame received (ScriptProcessor)', {
          samples: pcm.length,
          peak,
          byteLength: pcmBuffer.byteLength,
          sampleRate: TARGET_SAMPLE_RATE,
        })
      console.log('[audio-diag] first PCM frame (ScriptProcessor)', {
          samples: pcm.length,
          byteLength: pcmBuffer.byteLength,
          contextSampleRate: ctx.sampleRate,
          targetSampleRate: TARGET_SAMPLE_RATE,
        })
      }

      if (totalPCMFrames % 100 === 0) {
        const elapsedSec = (performance.now() - captureStartTime) / 1000
        const pcmDurationSec = (totalPCMBytes / 2) / 16000
      console.log('[audio-diag] PCM total (ScriptProcessor)', {
          frames: totalPCMFrames,
          totalBytes: totalPCMBytes,
          wallTimeSec: elapsedSec.toFixed(2),
          pcmDurationSec: pcmDurationSec.toFixed(2),
        })
      }

      onPCMFrame?.(pcm)
      onAudioData?.(pcmBuffer)
    }
  }

  src.connect(spn)
  // ScriptProcessorNode requires an output connection to work
  spn.connect(ctx.destination)
  console.log('[audio-diag] ScriptProcessorNode fallback active')
  addRuntimeEvent('info', 'audio', 'ScriptProcessorNode fallback activated', {
    bufferSize: 4096,
    inputSampleRate: ctx.sampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
  })
}

/** Try loading the AudioWorklet module via a data URL, then a Blob URL. */
async function tryLoadAudioWorklet(ctx: AudioContext): Promise<boolean> {
  try {
    const dataUrl = 'data:application/javascript;base64,' + btoa(PCM_WORKLET_CODE)
    await Promise.race([
      ctx.audioWorklet.addModule(dataUrl),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('addModule timeout')), 3000)),
    ])
    console.log('[audio-diag] AudioWorklet module loaded (data URL)')
    return true
  } catch (dataUrlErr) {
    console.warn('[audio-diag] data URL addModule failed:', dataUrlErr)
  }

  try {
    const blob = new Blob([PCM_WORKLET_CODE], { type: 'application/javascript' })
    const blobUrl = URL.createObjectURL(blob)
    try {
      await Promise.race([
        ctx.audioWorklet.addModule(blobUrl),
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('addModule timeout')), 3000)),
      ])
      console.log('[audio-diag] AudioWorklet module loaded (Blob URL)')
      return true
    } finally {
      URL.revokeObjectURL(blobUrl)
    }
  } catch (blobErr) {
    console.warn('[audio-diag] Blob URL addModule also failed:', blobErr)
  }

  return false
}

/** Create the AudioWorkletNode and attach its message handler. */
function setupAudioWorkletNode(ctx: AudioContext, src: AudioNode): AudioWorkletNode {
  const node = new AudioWorkletNode(ctx, 'pcm-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    processorOptions: {
      targetRate: TARGET_SAMPLE_RATE,
      inputRate: ctx.sampleRate,
    },
  })

    addRuntimeEvent('info', 'audio', 'AudioContext ready', {
    contextState: ctx.state,
    inputSampleRate: ctx.sampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
    ratio: (ctx.sampleRate / TARGET_SAMPLE_RATE).toFixed(4),
  })

  let totalPCMBytes = 0
  let totalPCMFrames = 0
  let captureStartTime = performance.now()

  node.port.onmessage = (e) => {
    // Signal worklet data receipt for the external silence monitor.
    node.dispatchEvent(new Event('worklet-data'))

    if (typeof e.data.sampleRate === 'number') {
      actualSampleRate = e.data.sampleRate
    }

    if (typeof e.data.rms === 'number') {
      if (!firstRmsLogged) {
        firstRmsLogged = true
        addRuntimeEvent('info', 'audio', 'First RMS received', {
          rms: Number(e.data.rms.toFixed(6)),
          sampleRate: actualSampleRate,
        })
      }
      onVolumeChange?.(e.data.rms)
    }

    const pcmBuffer = e.data.pcm as ArrayBuffer | undefined
    if (pcmBuffer && pcmBuffer.byteLength > 0) {
      const pcmFrame = new Int16Array(pcmBuffer)
      totalPCMBytes += pcmBuffer.byteLength
      totalPCMFrames++
      if (!firstPCMFrameLogged) {
        firstPCMFrameLogged = true
        captureStartTime = performance.now()
        let peak = 0
        for (let i = 0; i < pcmFrame.length; i++) {
          const value = Math.abs(pcmFrame[i])
          if (value > peak) peak = value
        }
        addRuntimeEvent('info', 'audio', 'First PCM frame received', {
          samples: pcmFrame.length,
          peak,
          byteLength: pcmBuffer.byteLength,
          sampleRate: actualSampleRate,
        })
        console.log('[audio-diag] first PCM frame', {
          samples: pcmFrame.length,
          byteLength: pcmBuffer.byteLength,
          contextSampleRate: audioCtx?.sampleRate,
          targetSampleRate: TARGET_SAMPLE_RATE,
          actualSampleRate,
        })
      }
      if (totalPCMFrames % 5000 === 0) {
        const elapsedSec = (performance.now() - captureStartTime) / 1000
        const pcmDurationSec = (totalPCMBytes / 2) / 16000
        console.log('[audio-diag] PCM total', {
          frames: totalPCMFrames,
          totalBytes: totalPCMBytes,
          wallTimeSec: elapsedSec.toFixed(2),
          pcmDurationSec: pcmDurationSec.toFixed(2),
        })
      }
      onPCMFrame?.(pcmFrame)
      onAudioData?.(pcmBuffer)
    }
  }

  src.connect(node)
  console.log('[audio-diag] sourceNode connected to workletNode')
  return node
}

export async function startCapture(
  deviceId: string | undefined,
  onData: (buffer: ArrayBuffer) => void,
  onVolume?: (volume: number) => void,
  onFrame?: (pcm: Int16Array) => void,
  noiseSuppression: boolean = true,
) {
  // Always tear down previous capture to prevent stale state leaks
  const hadPriorCtx = audioCtx !== null
  const hadPriorWorklet = workletNode !== null
  const hadPriorStream = mediaStream !== null
  if (hadPriorCtx || hadPriorWorklet || hadPriorStream) {
    console.warn('[audio-diag] startCapture found stale state; cleaning up', {
      hadAudioCtx: hadPriorCtx,
      priorCtxState: audioCtx?.state,
      hadWorklet: hadPriorWorklet,
      hadStream: hadPriorStream,
    })
    addRuntimeEvent('warn', 'audio', 'startCapture cleaned up stale state', {
      hadAudioCtx: hadPriorCtx,
      priorCtxState: audioCtx?.state,
      hadWorklet: hadPriorWorklet,
      hadStream: hadPriorStream,
    })
  }
  await teardownCapture()

  const boostConfig = await getSetting('micBoost', DEFAULT_MIC_BOOST)
    .then(resolveMicBoost)
    .catch(() => resolveMicBoost(DEFAULT_MIC_BOOST))

  onAudioData = onData
  onVolumeChange = onVolume ?? null
  onPCMFrame = onFrame ?? null
  firstPCMFrameLogged = false
  firstRmsLogged = false
  actualSampleRate = TARGET_SAMPLE_RATE
  usingFallback = false

  const constraints: MediaStreamConstraints = {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      // Enable noise suppression by default: some microphones have substantial
      // low-frequency electrical noise, which would otherwise be recorded as-is.
      // Browser suppression optimizes listening comfort, not ASR, and may remove
      // details the model needs. Keep it configurable so users with a clean
      // microphone environment can disable it and compare recognition results.
      // Fixed gain modes keep browser AGC disabled; auto delegates level control to the browser.
      noiseSuppression,
      autoGainControl: boostConfig.autoGainControl,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  }

  try {
    console.log('[audio-diag] getUserMedia starting...', { deviceId: deviceId || 'default' })
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints)
    const track = mediaStream.getAudioTracks()[0] || null
    const settings = track?.getSettings?.()
    const activeMicrophone: ActiveMicrophoneInfo = {
      // Prefer the resolved track setting over the requested id. In system-default mode
      // these may differ, and the resolved value is what the reminder needs to describe.
      deviceId: String(settings?.deviceId || deviceId || ''),
      groupId: String(settings?.groupId || ''),
      label: String(track?.label || ''),
    }

    console.log('[audio-diag] getUserMedia success', {
      trackCount: mediaStream.getAudioTracks().length,
      trackLabel: track?.label,
      trackEnabled: track?.enabled,
      trackMuted: track?.muted,
      trackReadyState: track?.readyState,
      settings,
    })

    addRuntimeEvent('info', 'audio', 'Microphone capture started', {
      requestedDeviceId: deviceId || 'default',
      trackLabel: track?.label || '',
      trackSettings: settings || null,
    })

    audioCtx = createAudioContext()
    actualSampleRate = audioCtx.sampleRate || TARGET_SAMPLE_RATE
    const nativeSixteenK = audioCtx.sampleRate === TARGET_SAMPLE_RATE
    console.log('[audio-diag] AudioContext created', {
      state: audioCtx.state,
      sampleRate: audioCtx.sampleRate,
      nativeSixteenK,
    })
    // This runtime event is the only evidence that the high-quality resampling
    // path was selected; check it first when diagnosing recognition accuracy.
    addRuntimeEvent('info', 'audio', nativeSixteenK ? 'AudioContext is natively 16 kHz; resampling skipped' : 'AudioContext is not 16 kHz; using linear resampling', {
      contextSampleRate: audioCtx.sampleRate,
      targetSampleRate: TARGET_SAMPLE_RATE,
    })

    sourceNode = audioCtx.createMediaStreamSource(mediaStream)
    gainNode = audioCtx.createGain()
    gainNode.gain.value = boostConfig.gain
    sourceNode.connect(gainNode)
    addRuntimeEvent('info', 'audio', 'Microphone boost configured', {
      setting: boostConfig.setting,
      gain: boostConfig.gain,
      autoGainControl: boostConfig.autoGainControl,
    })

    // Try AudioWorklet, with ScriptProcessor fallback
    const fallbackCtx = audioCtx
    const fallbackSrc = gainNode
    const fallbackTimerId = setTimeout(() => {
      if (!usingFallback && fallbackCtx === audioCtx && fallbackSrc === gainNode) {
      console.warn('[audio-diag] AudioWorklet timed out (1.5s); switching to ScriptProcessorNode')
      addRuntimeEvent('warn', 'audio', 'AudioWorklet timed out; switching to ScriptProcessorNode fallback')
        setupScriptProcessorFallback(fallbackCtx, fallbackSrc)
      }
    }, 1500)

    const workletLoaded = await tryLoadAudioWorklet(audioCtx)

    if (audioCtx.state === 'suspended') {
      console.log('[audio-diag] AudioContext is suspended, resuming...')
      await audioCtx.resume()
      console.log('[audio-diag] AudioContext resumed, state:', audioCtx.state)
    }

    if (!workletLoaded) {
      clearTimeout(fallbackTimerId)
      if (!usingFallback) {
        console.log('[audio-diag] AudioWorklet unavailable, using ScriptProcessorNode directly')
        setupScriptProcessorFallback(audioCtx, gainNode)
      }
      return activeMicrophone
    }

    clearTimeout(fallbackTimerId)
    if (usingFallback) {
      console.log('[audio-diag] ScriptProcessorNode already active, skipping worklet setup')
      return activeMicrophone
    }

    // AudioWorklet loaded — set up node and monitor for data
    workletNode = setupAudioWorkletNode(audioCtx, gainNode)

    // Secondary monitor: if worklet loaded but no data within 800ms, switch
    let gotWorkletData = false
    workletNode.addEventListener('worklet-data', () => { gotWorkletData = true }, { once: true })
    setTimeout(() => {
      if (!gotWorkletData && !usingFallback && fallbackCtx === audioCtx && fallbackSrc === gainNode) {
      console.warn('[audio-diag] AudioWorklet produced no data (800ms); switching to ScriptProcessorNode')
      addRuntimeEvent('warn', 'audio', 'AudioWorklet was silent; switching to ScriptProcessorNode fallback')
        setupScriptProcessorFallback(fallbackCtx, fallbackSrc)
      }
    }, 800)

    return activeMicrophone

  } catch (error) {
    await teardownCapture()
    addRuntimeEvent('error', 'audio', 'Failed to start microphone capture', {
      requestedDeviceId: deviceId || 'default',
      error: String(error),
    })
    throw error
  }
}

export async function stopCapture() {
  const finalCtxRate = audioCtx?.sampleRate
  console.log('[audio-diag] stopCapture final summary', {
    contextSampleRate: finalCtxRate,
    actualSampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
    usingFallback,
  })
  addRuntimeEvent('info', 'audio', 'Capture stop summary', {
    contextSampleRate: finalCtxRate,
    actualSampleRate,
    targetSampleRate: TARGET_SAMPLE_RATE,
    usingFallback,
  })

  await teardownCapture()

  onAudioData = null
  onVolumeChange = null
  onPCMFrame = null
}

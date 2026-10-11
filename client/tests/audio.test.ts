import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { constants, Script } from 'node:vm'
import { getActualSampleRate, startCapture, stopCapture } from '../src/services/audio'

// Only the native IPC boundary is replaced; capture and conversion run unchanged.
vi.mock('../src/services/bridge', () => ({
  storeGet: async () => null,
  appendDebugLog: () => {},
}))

interface PCMMessage {
  pcm?: ArrayBuffer
  rms: number
  sampleRate: number
}

class ProcessorPort {
  messages: PCMMessage[] = []
  onmessage: ((event: { data: PCMMessage }) => void) | null = null

  postMessage(message: PCMMessage, transfer: ArrayBuffer[] = []) {
    const received = structuredClone(message, { transfer })
    if (message.pcm) expect(message.pcm.byteLength).toBe(0)
    this.messages.push(received)
    this.onmessage?.({ data: received })
  }
}

interface Processor {
  port: ProcessorPort
  process(inputs: Float32Array[][]): boolean
}

type ProcessorConstructor = new (options: {
  processorOptions: { inputRate: number; targetRate: number }
}) => Processor

class AudioNodeStub extends EventTarget {
  connections = new Set<AudioNodeStub>()
  connect(node: AudioNodeStub) { this.connections.add(node) }
  disconnect(node?: AudioNodeStub) {
    if (node) this.connections.delete(node)
    else this.connections.clear()
  }
}

class ScriptProcessorStub extends AudioNodeStub {
  onaudioprocess: ((event: { inputBuffer: { getChannelData(channel: number): Float32Array } }) => void) | null = null
  feed(input: Float32Array) {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => input } })
  }
}

class WorkletNodeStub extends AudioNodeStub {
  port = { onmessage: null as ((event: { data: PCMMessage }) => void) | null }
  processor: Processor

  constructor(ctx: AudioContextStub, name: string, options: ConstructorParameters<ProcessorConstructor>[0]) {
    super()
    expect(name).toBe('pcm-processor')
    if (!ctx.processor) throw new Error('PCM processor was not registered')
    this.processor = new ctx.processor(options)
    this.processor.port.onmessage = (event) => this.port.onmessage?.(event)
    ctx.worklet = this
  }

  feed(input: Float32Array) {
    expect(this.processor.process([[input]])).toBe(true)
  }
}

// Native import executes the actual module source, including data-URL exports.
const nativeImport = new Script('import(url)', {
  importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER,
})
let importId = 0
let inputRate = 48000
let loadMode: 'data' | 'blob' | 'unavailable' | 'pending' = 'data'
let finishPendingLoad: (() => void) | undefined
let loadingContext: AudioContextStub
const contexts: AudioContextStub[] = []

async function registerWorklet(ctx: AudioContextStub, url: string) {
  loadingContext = ctx
  vi.stubGlobal('sampleRate', ctx.sampleRate)
  await nativeImport.runInNewContext({ url: `${url}#audio-test-${importId++}` })
}

class AudioContextStub {
  sampleRate = inputRate
  state = 'running'
  destination = new AudioNodeStub()
  source = new AudioNodeStub()
  gain = Object.assign(new AudioNodeStub(), { gain: { value: 1 } })
  processor?: ProcessorConstructor
  worklet?: WorkletNodeStub
  script?: ScriptProcessorStub
  loadedUrls: string[] = []
  audioWorklet = {
    addModule: async (url: string) => {
      this.loadedUrls.push(url)
      if (loadMode === 'unavailable' || (loadMode === 'blob' && url.startsWith('data:'))) {
        throw new Error('Worklet load rejected')
      }
      if (loadMode === 'pending') {
        await new Promise<void>((resolve) => { finishPendingLoad = resolve })
      }
      const source = await (await fetch(url)).text()
      await registerWorklet(this, 'data:application/javascript;base64,' + btoa(source))
    },
  }

  constructor() { contexts.push(this) }
  createMediaStreamSource() { return this.source }
  createGain() { return this.gain }
  createScriptProcessor() { return (this.script = new ScriptProcessorStub()) }
  async resume() { this.state = 'running' }
  async close() { this.state = 'closed' }
}

async function capture() {
  const buffers: ArrayBuffer[] = []
  const frames: Int16Array[] = []
  const volumes: number[] = []
  await startCapture(undefined, (buffer) => buffers.push(buffer), (rms) => volumes.push(rms), (pcm) => frames.push(pcm))
  return { buffers, frames, volumes, ctx: contexts[contexts.length - 1] }
}

const input = new Float32Array([-2, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 2, 0])
const fixtures = [
  { rate: 16000, pcm: [-32768, -32768, -24576, -16384, -8192, 0, 8191, 16383, 24575, 32767, 32767, 0] },
  { rate: 44100, pcm: [-32768, -18380, 4198, 26776] },
  { rate: 48000, pcm: [-32768, -16384, 8191, 32767] },
]

beforeEach(() => {
  vi.useFakeTimers()
  inputRate = 48000
  loadMode = 'data'
  finishPendingLoad = undefined
  contexts.length = 0
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal('window', { AudioContext: AudioContextStub })
  vi.stubGlobal('AudioWorkletNode', WorkletNodeStub)
  vi.stubGlobal('AudioWorkletProcessor', class { port = new ProcessorPort() })
  vi.stubGlobal('registerProcessor', (name: string, constructor: ProcessorConstructor) => {
    expect(name).toBe('pcm-processor')
    loadingContext.processor = constructor
  })
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => {
        const track = { label: 'Test microphone', getSettings: () => ({ deviceId: 'test-mic' }), stop: () => {} }
        return { getTracks: () => [track], getAudioTracks: () => [track] }
      },
    },
  })
})

afterEach(async () => {
  await stopCapture()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('PCM capture contract', () => {
  it('resamples independent streams without worklet globals or borrowed input state', async () => {
    vi.stubGlobal('AudioWorkletProcessor', undefined)
    vi.stubGlobal('registerProcessor', undefined)
    const { PCMResampler } = await nativeImport.runInNewContext({
      url: pathToFileURL(resolve('../server/web/pcm-processor.js')).href,
    }) as { PCMResampler: new (inputRate: number, targetRate: number) => { process(input: Float32Array): { pcm: Int16Array; rms: number } } }

    const first = new PCMResampler(48000, 16000)
    const second = new PCMResampler(48000, 16000)
    const block = new Float32Array([1])
    expect(first.process(block)).toEqual({ pcm: new Int16Array(0), rms: 1 })
    expect(block).toEqual(new Float32Array([1]))
    block[0] = -1
    expect(Array.from(second.process(new Float32Array([0, 0, 0])).pcm)).toEqual([0])
    expect(Array.from(first.process(new Float32Array([0, 0])).pcm)).toEqual([32767])

    const fractional = new PCMResampler(44100, 16000)
    const frames = [128, 128, 128, 57].map((length) => fractional.process(new Float32Array(length).fill(0.25)))
    // Preserve the original floating-point boundary: the last sample stays pending.
    expect(frames.map(({ pcm }) => pcm.length)).toEqual([46, 46, 47, 20])
    expect(frames.flatMap(({ pcm }) => Array.from(pcm))).toEqual(Array(159).fill(8191))
  })

  it.each(fixtures)('preserves $rate Hz PCM through desktop worklet and fallback', async ({ rate, pcm }) => {
    inputRate = rate
    for (const path of ['desktop', 'fallback']) {
      loadMode = path === 'fallback' ? 'unavailable' : 'data'
      const observed = await capture()
      const feed = (block: Float32Array) => {
        if (path === 'fallback') observed.ctx.script!.feed(block)
        else observed.ctx.worklet!.feed(block)
      }
      feed(input)
      expect(observed.buffers.flatMap((buffer) => Array.from(new Int16Array(buffer)))).toEqual(pcm)
      expect(observed.volumes).toEqual([Math.sqrt(23 / 48)])
      expect(getActualSampleRate()).toBe(16000)
      expect(observed.frames[0].buffer).toBe(observed.buffers[0])
      if (path !== 'fallback') {
        const messages = observed.ctx.worklet!.processor.port.messages
        expect(messages[0].sampleRate).toBe(16000)
        observed.ctx.worklet!.processor.process([])
        feed(new Float32Array(0))
        expect(messages).toHaveLength(1)
      }
      await stopCapture()
    }
  })

  it('delivers matching PCM and metadata from the standalone server module', async () => {
    const ctx = new AudioContextStub()
    await registerWorklet(ctx, pathToFileURL(resolve('../server/web/pcm-worklet.js')).href)
    for (const { rate, pcm } of fixtures) {
      const node = new WorkletNodeStub(ctx, 'pcm-processor', { processorOptions: { inputRate: rate, targetRate: 16000 } })
      node.feed(input)
      const [message] = node.processor.port.messages
      expect(Array.from(new Int16Array(message.pcm!))).toEqual(pcm)
      expect(message.rms).toBe(Math.sqrt(23 / 48))
      expect(message.sampleRate).toBe(16000)
    }
  })

  it.each(['data', 'unavailable'] as const)('carries fractional phase across short blocks using %s loading', async (mode) => {
    inputRate = 44100
    loadMode = mode
    const observed = await capture()
    for (const [start, end] of [[0, 1], [1, 3], [3, 7], [7, 12]]) {
      const block = input.slice(start, end)
      if (observed.ctx.script) observed.ctx.script.feed(block)
      else observed.ctx.worklet!.feed(block)
    }
    expect(observed.buffers.flatMap((buffer) => Array.from(new Int16Array(buffer)))).toEqual(fixtures[1].pcm)
    expect(observed.volumes).toHaveLength(4)
    if (observed.ctx.worklet) {
      expect(observed.ctx.worklet.processor.port.messages[0]).toEqual({ rms: 1, sampleRate: 16000 })
    }
  })

  it('loads the same PCM processor through a Blob when data URLs are rejected', async () => {
    loadMode = 'blob'
    const observed = await capture()
    observed.ctx.worklet!.feed(input)
    expect(observed.buffers.flatMap((buffer) => Array.from(new Int16Array(buffer)))).toEqual(fixtures[2].pcm)
    expect(observed.ctx.loadedUrls.map((url) => url.split(':')[0])).toEqual(['data', 'blob'])
    expect(observed.ctx.script).toBeUndefined()
  })

  it('starts a fresh fallback stream after a silent worklet and on the next capture', async () => {
    const first = await capture()
    await vi.advanceTimersByTimeAsync(800)
    expect(first.ctx.worklet!.port.onmessage).toBeNull()
    first.ctx.worklet!.feed(new Float32Array([1, 1, 1]))
    expect(first.buffers).toHaveLength(0)
    first.ctx.script!.feed(new Float32Array([1]))
    expect(first.buffers).toHaveLength(0)
    await stopCapture()
    expect(first.ctx.script!.onaudioprocess).toBeNull()
    expect(first.ctx.state).toBe('closed')

    loadMode = 'unavailable'
    const second = await capture()
    second.ctx.script!.feed(new Float32Array([0, 0, 0]))
    expect(second.buffers.map((buffer) => Array.from(new Int16Array(buffer)))).toEqual([[0]])
    expect(first.buffers).toHaveLength(0)
  })

  it('keeps fallback active when a timed-out worklet finishes loading', async () => {
    loadMode = 'pending'
    const starting = capture()
    await vi.advanceTimersByTimeAsync(1500)
    expect(contexts[0].script).toBeDefined()
    finishPendingLoad!()
    const observed = await starting
    expect(observed.ctx.worklet).toBeUndefined()
    observed.ctx.script!.feed(input)
    expect(observed.buffers.flatMap((buffer) => Array.from(new Int16Array(buffer)))).toEqual(fixtures[2].pcm)
  })
})

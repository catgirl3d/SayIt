import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => native.invoke(...args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('@/services/debugLog', () => ({ addRuntimeEvent: vi.fn() }))

import { setLocale } from '@/i18n'
import { OverlayService } from '../OverlayService'

const IDLE_SUSPEND_MS = 5000

// Captured before fake timers are installed: used to give Node a real turn so that an
// unhandled rejection raised by a test is reported before the test ends.
const realSetImmediate = Reflect.get(globalThis, 'setImmediate') as (callback: () => void) => void
const processEvents = Reflect.get(globalThis, 'process') as {
  on: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
  off: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
}

type FakeState = 'suspended' | 'running' | 'closed'
type Op = 'resume' | 'suspend'

interface HeldCall {
  settle(): void
  fail(error: Error): void
}

/**
 * Shared state of the fake Web Audio implementation. Every observable action of every context
 * and oscillator is appended to `log`, so a test can assert the exact order of transitions.
 */
const harness = {
  log: [] as string[],
  contexts: [] as FakeAudioContext[],
  /** Operations whose promise stays pending until the test settles or fails it. */
  holds: new Set<Op>(),
  initialState: 'running' as FakeState,
  constructorError: null as Error | null,
}

class FakeOscillator {
  readonly frequency = { value: 0 }
  type = 'square'
  onended: (() => void) | null = null
  startedAt: number | null = null
  stoppedAt: number | null = null

  constructor(readonly id: number) { }

  connect() { }

  start(when: number) {
    this.startedAt = when
    harness.log.push(`osc${this.id}.start`)
  }

  stop(when: number) {
    this.stoppedAt = when
  }

  fireEnded() {
    harness.log.push(`osc${this.id}.ended`)
    this.onended?.()
  }
}

class FakeGain {
  readonly events: Array<{ kind: 'set' | 'ramp'; value: number; time: number }> = []
  readonly gain = {
    setValueAtTime: (value: number, time: number) => {
      this.events.push({ kind: 'set', value, time })
    },
    exponentialRampToValueAtTime: (value: number, time: number) => {
      this.events.push({ kind: 'ramp', value, time })
    },
  }

  connect() { }
}

class FakeAudioContext {
  state: FakeState
  readonly currentTime = 0
  readonly destination = {}
  readonly oscillators: FakeOscillator[] = []
  readonly gains: FakeGain[] = []
  readonly held: Record<Op, HeldCall[]> = { resume: [], suspend: [] }

  constructor() {
    if (harness.constructorError) throw harness.constructorError
    this.state = harness.initialState
    harness.contexts.push(this)
    harness.log.push('create')
  }

  createOscillator() {
    const oscillator = new FakeOscillator(this.oscillators.length + 1)
    this.oscillators.push(oscillator)
    return oscillator
  }

  createGain() {
    const gain = new FakeGain()
    this.gains.push(gain)
    return gain
  }

  resume() {
    return this.transition('resume', 'running')
  }

  suspend() {
    return this.transition('suspend', 'suspended')
  }

  close() {
    harness.log.push('close')
    this.state = 'closed'
    return Promise.resolve()
  }

  /** The state changes only when the promise settles, like in a real AudioContext. */
  private transition(op: Op, target: FakeState): Promise<void> {
    harness.log.push(op)
    const apply = () => {
      this.state = target
      harness.log.push(`${op}:settled`)
    }
    if (!harness.holds.has(op)) {
      return Promise.resolve().then(apply)
    }
    return new Promise<void>((resolve, reject) => {
      this.held[op].push({
        settle: () => {
          apply()
          resolve()
        },
        fail: (error) => {
          harness.log.push(`${op}:rejected`)
          reject(error)
        },
      })
    })
  }
}

const settings: Record<string, unknown> = {}
const unhandled: unknown[] = []
const onUnhandledRejection = (reason: unknown) => {
  unhandled.push(reason)
}

async function createOverlay(options: { readySound?: boolean } = {}) {
  settings.readySoundEnabled = options.readySound ?? true
  const overlay = new OverlayService(() => 0)
  await overlay.refreshSettings()
  return overlay
}

/** Let every queued microtask (including the whole step chain) run. */
async function flush() {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

function count(entry: string) {
  return harness.log.filter((item) => item === entry).length
}

function takeHeld(ctx: FakeAudioContext, op: Op): HeldCall {
  const call = ctx.held[op].shift()
  if (!call) throw new Error(`no held ${op} call`)
  return call
}

/** The PTT Lab / recorder tone request: the microphone is up. */
async function playTone(overlay: OverlayService) {
  overlay.startListeningTicker()
  overlay.stopListeningTicker()
  await flush()
}

describe('overlay ready sound', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setLocale('en')
    harness.log = []
    harness.contexts = []
    harness.holds = new Set()
    harness.initialState = 'running'
    harness.constructorError = null
    for (const key of Object.keys(settings)) delete settings[key]
    unhandled.length = 0
    processEvents.on('unhandledRejection', onUnhandledRejection)
    native.invoke.mockReset().mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'store_get') return settings[(args as { key: string }).key]
      return undefined
    })
    vi.stubGlobal('AudioContext', FakeAudioContext)
  })

  afterEach(async () => {
    await new Promise<void>((resolve) => realSetImmediate(() => resolve()))
    processEvents.off('unhandledRejection', onUnhandledRejection)
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllGlobals()
    expect(unhandled).toEqual([])
  })

  it('R1: the first tone creates one context, emits one oscillator and suspends the context once the tone has ended', async () => {
    const overlay = await createOverlay()

    await playTone(overlay)

    expect(harness.contexts).toHaveLength(1)
    const ctx = harness.contexts[0]
    expect(ctx.oscillators).toHaveLength(1)
    expect(harness.log).toEqual(['create', 'osc1.start'])
    expect(ctx.state).toBe('running')

    ctx.oscillators[0].fireEnded()
    await flush()

    expect(harness.log).toEqual(['create', 'osc1.start', 'osc1.ended', 'suspend', 'suspend:settled'])
    expect(count('suspend')).toBe(1)
    expect(count('close')).toBe(0)
    expect(ctx.state).toBe('suspended')
  })

  it('keeps the tone itself unchanged: 880 Hz sine, 0.2 gain decaying to 0.001 over 150 ms', async () => {
    const overlay = await createOverlay()

    await playTone(overlay)

    const ctx = harness.contexts[0]
    const osc = ctx.oscillators[0]
    expect(osc.frequency.value).toBe(880)
    expect(osc.type).toBe('sine')
    expect(osc.startedAt).toBe(0)
    expect(osc.stoppedAt).toBe(0.15)
    expect(ctx.gains[0].events).toEqual([
      { kind: 'set', value: 0.2, time: 0 },
      { kind: 'ramp', value: 0.001, time: 0.15 },
    ])
  })

  it('R2: a second recording starts exactly one resume at showWaiting and emits the tone only after it resolved', async () => {
    harness.initialState = 'suspended'
    const overlay = await createOverlay()
    overlay.showWaiting()
    await playTone(overlay)
    const ctx = harness.contexts[0]
    ctx.oscillators[0].fireEnded()
    await flush()
    expect(ctx.state).toBe('suspended')

    harness.log.length = 0
    harness.holds.add('resume')
    overlay.showWaiting()
    await flush()
    expect(harness.log).toEqual(['resume'])

    await playTone(overlay)
    expect(harness.log).toEqual(['resume'])
    expect(ctx.oscillators).toHaveLength(1)

    takeHeld(ctx, 'resume').settle()
    await flush()

    expect(harness.log).toEqual(['resume', 'resume:settled', 'osc2.start'])
    expect(harness.contexts).toHaveLength(1)
    expect(count('close')).toBe(0)
  })

  it('R3: a warm-up without a tone suspends nothing before the idle timeout and suspends exactly at it', async () => {
    const overlay = await createOverlay()

    overlay.showWaiting()
    await flush()
    expect(harness.log).toEqual(['create'])

    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1)
    await flush()
    expect(count('suspend')).toBe(0)
    expect(harness.contexts[0].state).toBe('running')

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(harness.log).toEqual(['create', 'suspend', 'suspend:settled'])
    expect(harness.contexts[0].state).toBe('suspended')
  })

  it('R3: a suspended context is woken by the warm-up and suspended again when no tone follows', async () => {
    harness.initialState = 'suspended'
    const overlay = await createOverlay()

    overlay.showWaiting()
    await flush()
    expect(harness.log).toEqual(['create', 'resume', 'resume:settled'])
    expect(harness.contexts[0].state).toBe('running')

    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1)
    await flush()
    expect(count('suspend')).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(harness.log).toEqual(['create', 'resume', 'resume:settled', 'suspend', 'suspend:settled'])
    expect(harness.contexts[0].state).toBe('suspended')
  })

  it('R3: a new warm-up re-arms the idle timer instead of keeping the earlier deadline', async () => {
    const overlay = await createOverlay()

    overlay.showWaiting()
    await vi.advanceTimersByTimeAsync(3000)
    overlay.showWaiting()
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS - 1)
    await flush()
    expect(count('suspend')).toBe(0)

    await vi.advanceTimersByTimeAsync(1)
    await flush()
    expect(count('suspend')).toBe(1)
    expect(harness.contexts[0].state).toBe('suspended')
  })

  it('R4: a tone started before the idle timeout cancels the timer, so nothing is suspended until the tone ends', async () => {
    const overlay = await createOverlay()
    overlay.showWaiting()
    await vi.advanceTimersByTimeAsync(2000)

    await playTone(overlay)

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 2)
    await flush()
    expect(harness.log).toEqual(['create', 'osc1.start'])
    expect(harness.contexts[0].state).toBe('running')

    harness.contexts[0].oscillators[0].fireEnded()
    await flush()
    expect(harness.log).toEqual(['create', 'osc1.start', 'osc1.ended', 'suspend', 'suspend:settled'])
    expect(harness.contexts[0].state).toBe('suspended')
  })

  it('R5: a tone requested while a suspend is in flight waits for it, then resumes, then emits', async () => {
    const overlay = await createOverlay()
    await playTone(overlay)
    const ctx = harness.contexts[0]
    harness.holds.add('suspend')
    ctx.oscillators[0].fireEnded()
    await flush()
    const beforeRace = ['create', 'osc1.start', 'osc1.ended', 'suspend']
    expect(harness.log).toEqual(beforeRace)

    await playTone(overlay)

    expect(ctx.oscillators).toHaveLength(1)
    expect(harness.log).toEqual(beforeRace)

    harness.holds.delete('suspend')
    takeHeld(ctx, 'suspend').settle()
    await flush()

    expect(harness.log).toEqual([...beforeRace, 'suspend:settled', 'resume', 'resume:settled', 'osc2.start'])
    expect(ctx.oscillators).toHaveLength(2)

    ctx.oscillators[1].fireEnded()
    await flush()
    expect(harness.log.slice(-3)).toEqual(['osc2.ended', 'suspend', 'suspend:settled'])
    expect(ctx.state).toBe('suspended')
    expect(harness.contexts).toHaveLength(1)
  })

  it('R5: a tone requested while the idle-timeout suspend is in flight also waits for it', async () => {
    const overlay = await createOverlay()
    overlay.showWaiting()
    await flush()
    harness.holds.add('suspend')
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS)
    await flush()
    expect(harness.log).toEqual(['create', 'suspend'])

    await playTone(overlay)
    expect(harness.contexts[0].oscillators).toHaveLength(0)

    harness.holds.delete('suspend')
    takeHeld(harness.contexts[0], 'suspend').settle()
    await flush()

    expect(harness.log).toEqual(['create', 'suspend', 'suspend:settled', 'resume', 'resume:settled', 'osc1.start'])
  })

  it('R6: with two overlapping tones the context is suspended once, after the second one ends', async () => {
    const overlay = await createOverlay()
    await playTone(overlay)
    await playTone(overlay)
    const ctx = harness.contexts[0]
    expect(ctx.oscillators).toHaveLength(2)
    expect(harness.log).toEqual(['create', 'osc1.start', 'osc2.start'])

    ctx.oscillators[0].fireEnded()
    await flush()
    expect(count('suspend')).toBe(0)
    expect(ctx.state).toBe('running')

    ctx.oscillators[1].fireEnded()
    await flush()
    expect(harness.log).toEqual([
      'create', 'osc1.start', 'osc2.start', 'osc1.ended', 'osc2.ended', 'suspend', 'suspend:settled',
    ])
    expect(count('suspend')).toBe(1)
    expect(ctx.state).toBe('suspended')
  })

  it('R7: with the sound disabled neither showWaiting nor startListeningTicker creates a context or arms a timer', async () => {
    const overlay = await createOverlay({ readySound: false })

    overlay.showWaiting()
    overlay.startListeningTicker()
    overlay.stopListeningTicker()
    await flush()
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS * 2)
    await flush()

    expect(harness.contexts).toHaveLength(0)
    expect(harness.log).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('R7: turning the sound off after a warm-up still lets the idle timer suspend the context', async () => {
    const overlay = await createOverlay()
    overlay.showWaiting()
    await flush()
    settings.readySoundEnabled = false
    await overlay.refreshSettings()

    await playTone(overlay)
    expect(harness.log).toEqual(['create'])

    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS)
    await flush()
    expect(harness.log).toEqual(['create', 'suspend', 'suspend:settled'])
  })

  it('R8: a resume that rejects during the warm-up surfaces nothing and the next tone retries and plays', async () => {
    harness.initialState = 'suspended'
    harness.holds.add('resume')
    const overlay = await createOverlay()

    overlay.showWaiting()
    await flush()
    takeHeld(harness.contexts[0], 'resume').fail(new Error('device busy'))
    await flush()
    expect(harness.log).toEqual(['create', 'resume', 'resume:rejected'])
    expect(harness.contexts[0].state).toBe('suspended')

    harness.holds.delete('resume')
    await playTone(overlay)

    expect(harness.log).toEqual([
      'create', 'resume', 'resume:rejected', 'resume', 'resume:settled', 'osc1.start',
    ])
    expect(harness.contexts).toHaveLength(1)

    harness.contexts[0].oscillators[0].fireEnded()
    await flush()
    expect(harness.contexts[0].state).toBe('suspended')
  })

  it('R8: a resume that rejects for a tone drops that tone, surfaces nothing and the next tone retries and plays', async () => {
    harness.initialState = 'suspended'
    harness.holds.add('resume')
    const overlay = await createOverlay()

    await playTone(overlay)
    takeHeld(harness.contexts[0], 'resume').fail(new Error('device busy'))
    await flush()
    expect(harness.log).toEqual(['create', 'resume', 'resume:rejected'])
    expect(harness.contexts[0].oscillators).toHaveLength(0)

    harness.holds.delete('resume')
    await playTone(overlay)

    expect(harness.log).toEqual([
      'create', 'resume', 'resume:rejected', 'resume', 'resume:settled', 'osc1.start',
    ])

    harness.contexts[0].oscillators[0].fireEnded()
    await flush()
    expect(harness.log.slice(-3)).toEqual(['osc1.ended', 'suspend', 'suspend:settled'])
    expect(harness.contexts[0].state).toBe('suspended')
  })

  it('R8: a constructor that throws never throws out of showWaiting or startListeningTicker, and the next try creates a context', async () => {
    harness.constructorError = new Error('audio unsupported')
    const overlay = await createOverlay()

    expect(() => overlay.showWaiting()).not.toThrow()
    expect(() => overlay.startListeningTicker()).not.toThrow()
    overlay.stopListeningTicker()
    await flush()
    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS)
    await flush()
    expect(harness.contexts).toHaveLength(0)

    harness.constructorError = null
    await playTone(overlay)

    expect(harness.contexts).toHaveLength(1)
    expect(harness.log).toEqual(['create', 'osc1.start'])
  })

  it('R8: an environment without any AudioContext (jsdom, unsupported WebView) neither throws nor creates timers', async () => {
    vi.unstubAllGlobals()
    const overlay = await createOverlay()

    expect(() => overlay.showWaiting()).not.toThrow()
    expect(() => overlay.startListeningTicker()).not.toThrow()
    overlay.stopListeningTicker()
    await flush()

    expect(harness.log).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('R9: a closed context is replaced by a new one on the next tone and the old one is left alone', async () => {
    const overlay = await createOverlay()
    await playTone(overlay)
    harness.contexts[0].oscillators[0].fireEnded()
    await flush()
    harness.contexts[0].state = 'closed'
    harness.log.length = 0

    await playTone(overlay)

    expect(harness.contexts).toHaveLength(2)
    expect(harness.log).toEqual(['create', 'osc1.start'])
    expect(harness.contexts[0].oscillators).toHaveLength(1)
    expect(harness.contexts[1].oscillators).toHaveLength(1)
  })

  it('R9: a closed context is replaced by a new one at the warm-up too', async () => {
    harness.initialState = 'suspended'
    const overlay = await createOverlay()
    overlay.showWaiting()
    await flush()
    harness.contexts[0].state = 'closed'
    harness.log.length = 0

    overlay.showWaiting()
    await flush()

    expect(harness.contexts).toHaveLength(2)
    expect(harness.log).toEqual(['create', 'resume', 'resume:settled'])
    expect(harness.contexts[1].state).toBe('running')
  })

  it('R10: a suspend that rejects surfaces nothing and the next tone plays without waking the context', async () => {
    const overlay = await createOverlay()
    await playTone(overlay)
    const ctx = harness.contexts[0]
    harness.holds.add('suspend')
    ctx.oscillators[0].fireEnded()
    await flush()
    takeHeld(ctx, 'suspend').fail(new Error('suspend failed'))
    await flush()
    expect(harness.log).toEqual(['create', 'osc1.start', 'osc1.ended', 'suspend', 'suspend:rejected'])
    expect(ctx.state).toBe('running')

    harness.holds.delete('suspend')
    await playTone(overlay)

    expect(harness.log.slice(-1)).toEqual(['osc2.start'])
    expect(count('resume')).toBe(0)

    ctx.oscillators[1].fireEnded()
    await flush()
    expect(harness.log.slice(-3)).toEqual(['osc2.ended', 'suspend', 'suspend:settled'])
    expect(ctx.state).toBe('suspended')
  })

  it('R11: PTT Lab path, a tone request alone on a suspended context resumes it and then emits', async () => {
    harness.initialState = 'suspended'
    harness.holds.add('resume')
    const overlay = await createOverlay()

    await playTone(overlay)
    expect(harness.log).toEqual(['create', 'resume'])
    expect(harness.contexts[0].oscillators).toHaveLength(0)

    takeHeld(harness.contexts[0], 'resume').settle()
    await flush()

    expect(harness.log).toEqual(['create', 'resume', 'resume:settled', 'osc1.start'])
  })

  it('R11: showWaiting immediately followed by startListeningTicker, as PTT Lab does, resumes once and then emits', async () => {
    harness.initialState = 'suspended'
    harness.holds.add('resume')
    const overlay = await createOverlay()

    overlay.showWaiting()
    await playTone(overlay)
    expect(harness.log).toEqual(['create', 'resume'])

    takeHeld(harness.contexts[0], 'resume').settle()
    await flush()

    expect(harness.log).toEqual(['create', 'resume', 'resume:settled', 'osc1.start'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('R12: no suspend is requested for a context that is already suspended after a failed warm-up', async () => {
    harness.initialState = 'suspended'
    harness.holds.add('resume')
    const overlay = await createOverlay()
    overlay.showWaiting()
    await flush()
    takeHeld(harness.contexts[0], 'resume').fail(new Error('device busy'))
    await flush()

    await vi.advanceTimersByTimeAsync(IDLE_SUSPEND_MS)
    await flush()

    expect(harness.contexts[0].state).toBe('suspended')
    expect(count('suspend')).toBe(0)
  })

  it('R12: no suspend is requested when the context was suspended by someone else before the tone ended', async () => {
    const overlay = await createOverlay()
    await playTone(overlay)
    harness.contexts[0].state = 'suspended'

    harness.contexts[0].oscillators[0].fireEnded()
    await flush()

    expect(count('suspend')).toBe(0)
  })

  it('R13: showWaiting alone starts the warm-up of a suspended context', async () => {
    harness.initialState = 'suspended'
    harness.holds.add('resume')
    const overlay = await createOverlay()

    overlay.showWaiting()
    await flush()

    expect(harness.log).toEqual(['create', 'resume'])
  })

  it('keeps a separate context per OverlayService instance', async () => {
    const recorderOverlay = await createOverlay()
    const labOverlay = await createOverlay()

    await playTone(recorderOverlay)
    await playTone(labOverlay)

    expect(harness.contexts).toHaveLength(2)
    expect(harness.contexts[0].oscillators).toHaveLength(1)
    expect(harness.contexts[1].oscillators).toHaveLength(1)
  })
})

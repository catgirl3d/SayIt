import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dependencies = vi.hoisted(() => ({
  emit: vi.fn(),
  getPTTPhysicalKeyStates: vi.fn(async (codes: string[]) => codes.map(() => true)),
  settings: new Map<string, unknown>(),
}))

vi.mock('@tauri-apps/api/event', () => ({ emit: dependencies.emit }))
vi.mock('../bridge', () => ({ getPTTPhysicalKeyStates: dependencies.getPTTPhysicalKeyStates }))
vi.mock('../store', () => ({
  getSetting: async (key: string, fallback?: unknown) => dependencies.settings.get(key) ?? fallback,
}))

import { startWebviewKeyboardFallback, stopWebviewKeyboardFallback } from '../webviewKeyboardFallback'

class TestKeyboardEvent extends Event {
  readonly code: string
  readonly altKey: boolean
  readonly ctrlKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean

  constructor(
    type: string,
    code: string,
    modifiers: Partial<Pick<TestKeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
  ) {
    super(type, { cancelable: true })
    this.code = code
    this.altKey = modifiers.altKey ?? false
    this.ctrlKey = modifiers.ctrlKey ?? false
    this.metaKey = modifiers.metaKey ?? false
    this.shiftKey = modifiers.shiftKey ?? false
  }
}

let documentTarget: EventTarget

function dispatchKeyboard(
  type: 'keydown' | 'keyup',
  code: string,
  modifiers: Partial<Pick<TestKeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {},
) {
  const event = new TestKeyboardEvent(type, code, modifiers)
  documentTarget.dispatchEvent(event)
  return event
}

async function startFallback(pttSetting: string, handsFreeSetting = '') {
  dependencies.settings.set('shortcutPTT', pttSetting)
  dependencies.settings.set('shortcutHandsFree', handsFreeSetting)
  await startWebviewKeyboardFallback()
}

function emittedEvents() {
  return dependencies.emit.mock.calls.map(([eventName]) => eventName)
}

describe('focused WebView keyboard fallback modifier guard', () => {
  beforeEach(() => {
    documentTarget = new EventTarget()
    vi.stubGlobal('document', documentTarget)
    vi.stubGlobal('window', new EventTarget())
    dependencies.settings.clear()
    dependencies.emit.mockClear()
    dependencies.getPTTPhysicalKeyStates.mockClear()
  })

  afterEach(() => {
    stopWebviewKeyboardFallback()
    vi.unstubAllGlobals()
  })

  it.each([
    { mode: 'PTT', setting: 'F4', ptt: 'F4', handsFree: '' },
    { mode: 'PTT', setting: 'F13', ptt: 'F13', handsFree: '' },
    { mode: 'hands-free', setting: 'F4', ptt: 'ControlRight', handsFree: 'F4' },
    { mode: 'hands-free', setting: 'F13', ptt: 'ControlRight', handsFree: 'F13' },
  ])(
    'ignores repeated modified $mode downs and their unpaired keyup for $setting',
    async ({ setting, ptt, handsFree }) => {
      await startFallback(ptt, handsFree)

      const blockedDown = dispatchKeyboard('keydown', setting, { ctrlKey: true })
      const blockedRepeat = dispatchKeyboard('keydown', setting, { metaKey: true })
      const unpairedUp = dispatchKeyboard('keyup', setting, { altKey: true })

      expect.soft(emittedEvents()).toEqual([])
      expect
        .soft([blockedDown.defaultPrevented, blockedRepeat.defaultPrevented, unpairedUp.defaultPrevented])
        .toEqual([false, false, false])
    },
  )

  it('keeps accepted PTT ownership across a rejected modified repeat and releases on modified keyup', async () => {
    await startFallback('F4')

    const firstDown = dispatchKeyboard('keydown', 'F4')
    const acceptedRepeat = dispatchKeyboard('keydown', 'F4')
    const rejectedRepeat = dispatchKeyboard('keydown', 'F4', { shiftKey: true })
    const pairedUp = dispatchKeyboard('keyup', 'F4', { ctrlKey: true })

    expect(emittedEvents()).toEqual(['ptt-down', 'ptt-up'])
    expect([
      firstDown.defaultPrevented,
      acceptedRepeat.defaultPrevented,
      rejectedRepeat.defaultPrevented,
      pairedUp.defaultPrevented,
    ]).toEqual([true, true, false, true])
    expect(dependencies.emit.mock.calls.map(([, payload]) => (payload as { reason: string }).reason)).toEqual([
      'all_members_down',
      'member_up',
    ])
  })

  it('accepts a later unmodified PTT down after rejecting a modified down', async () => {
    await startFallback('F13')

    const rejectedDown = dispatchKeyboard('keydown', 'F13', { altKey: true })
    const acceptedDown = dispatchKeyboard('keydown', 'F13')
    const pairedUp = dispatchKeyboard('keyup', 'F13', { metaKey: true })

    expect(emittedEvents()).toEqual(['ptt-down', 'ptt-up'])
    expect([rejectedDown.defaultPrevented, acceptedDown.defaultPrevented, pairedUp.defaultPrevented]).toEqual([
      false,
      true,
      true,
    ])
  })

  it('keeps bare hands-free acceptance debounced until keyup', async () => {
    await startFallback('ControlRight', 'F13')

    const firstDown = dispatchKeyboard('keydown', 'F13')
    const repeatDown = dispatchKeyboard('keydown', 'F13')
    const pairedUp = dispatchKeyboard('keyup', 'F13')

    expect(emittedEvents()).toEqual(['toggle-hands-free'])
    expect([firstDown.defaultPrevented, repeatDown.defaultPrevented, pairedUp.defaultPrevented]).toEqual([
      false,
      false,
      false,
    ])
  })

  it('does not block a configured modifier key used as its own PTT or hands-free shortcut', async () => {
    await startFallback('ControlRight', 'AltRight')

    const pttDown = dispatchKeyboard('keydown', 'ControlRight', { ctrlKey: true, altKey: true })
    const handsFreeDown = dispatchKeyboard('keydown', 'AltRight', { altKey: true })
    const pttUp = dispatchKeyboard('keyup', 'ControlRight', { altKey: true })
    const handsFreeUp = dispatchKeyboard('keyup', 'AltRight')

    expect(emittedEvents()).toEqual(['ptt-down', 'toggle-hands-free', 'ptt-up'])
    expect([
      pttDown.defaultPrevented,
      handsFreeDown.defaultPrevented,
      pttUp.defaultPrevented,
      handsFreeUp.defaultPrevented,
    ]).toEqual([true, true, true, true])
  })

  it('keeps modifier-first PTT combo handling and paired consumption unchanged', async () => {
    await startFallback('ControlLeft+KeyK')

    const modifierDown = dispatchKeyboard('keydown', 'ControlLeft', { ctrlKey: true })
    const mainDown = dispatchKeyboard('keydown', 'KeyK', { ctrlKey: true, shiftKey: true })
    const mainUp = dispatchKeyboard('keyup', 'KeyK')

    expect(emittedEvents()).toEqual(['ptt-down', 'ptt-up'])
    expect([modifierDown.defaultPrevented, mainDown.defaultPrevented, mainUp.defaultPrevented]).toEqual([
      false,
      true,
      true,
    ])
  })
})

import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SubtitleSavingSettings from '../SubtitleSavingSettings'

const mocks = vi.hoisted(() => ({
  switchProps: [] as Array<{ checked: boolean; disabled?: boolean; label?: string; onChange: () => void }>,
  buttonProps: [] as Array<{ children?: unknown; ariaLabel?: string; disabled?: boolean; onClick?: (event?: unknown) => void }>,
  effects: [] as Array<() => void | (() => void)>,
  stateValues: [] as unknown[],
  stateCursor: 0,
  getSetting: vi.fn(),
  setSetting: vi.fn(),
  resolveDir: vi.fn(),
  openFolder: vi.fn(),
  pickFolder: vi.fn(),
  addRuntimeEvent: vi.fn(),
}))

// The component's state is driven by hand: each useState slot is keyed by call order, and the render
// is static, so a test steps the component the way a browser would (render, run the effect, render).
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T): [T, (next: T | ((previous: T) => T)) => void] => {
      const index = mocks.stateCursor++
      if (!(index in mocks.stateValues)) mocks.stateValues[index] = initial
      return [mocks.stateValues[index] as T, (next) => {
        mocks.stateValues[index] = typeof next === 'function'
          ? (next as (previous: T) => T)(mocks.stateValues[index] as T)
          : next
      }]
    },
    useEffect: (effect: () => void | (() => void)) => {
      mocks.effects.push(effect)
    },
  }
})

vi.mock('@/services/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/store')>()
  return { ...actual, getSetting: mocks.getSetting, setSetting: mocks.setSetting }
})

vi.mock('@/services/debugLog', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/debugLog')>()
  return { ...actual, addRuntimeEvent: mocks.addRuntimeEvent }
})

vi.mock('@/services/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bridge')>()
  return {
    ...actual,
    resolveSubtitleTranscriptDir: mocks.resolveDir,
    openSubtitleTranscriptFolder: mocks.openFolder,
  }
})

vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mocks.pickFolder }))

vi.mock('@/components/ui/switch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/switch')>()
  const React = await import('react')
  return {
    ...actual,
    Switch: (props: Parameters<typeof actual.Switch>[0]) => {
      mocks.switchProps.push(props)
      return React.createElement(actual.Switch, props)
    },
  }
})

vi.mock('@/components/ui/button', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/button')>()
  const React = await import('react')
  return {
    ...actual,
    Button: (props: Parameters<typeof actual.Button>[0]) => {
      mocks.buttonProps.push({
        children: props.children,
        ariaLabel: props['aria-label'],
        disabled: props.disabled,
        onClick: props.onClick as unknown as ((event?: unknown) => void) | undefined,
      })
      return React.createElement(actual.Button, props)
    },
  }
})

// The real Modal renders through a portal, which the static server renderer rejects. An open dialog
// is rendered in place instead, so its controls stay reachable through the Switch and Button spies.
vi.mock('@/components/ui/modal', async () => {
  const React = await import('react')
  return {
    Modal: ({ title, children }: { title: string; children: ReactNode }) => (
      React.createElement('div', { role: 'dialog', 'aria-label': title }, children)
    ),
  }
})

const CONFIGURE_SAVING = 'Configure saving subtitles'
const journalLabel = 'Save a text journal of subtitles'
const loadFailedMessage = 'Could not load the subtitle saving settings.'
const saveFailedMessage = 'Could not save the transcript setting.'

const onPendingChange = vi.fn()
let active = false
let pending = false

const render = () => {
  mocks.stateCursor = 0
  return renderToStaticMarkup(createElement(SubtitleSavingSettings, { active, pending, onPendingChange }))
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function resetHarness(settings: Record<string, unknown> = {}) {
  mocks.effects.length = 0
  mocks.switchProps.length = 0
  mocks.buttonProps.length = 0
  mocks.stateValues.length = 0
  mocks.stateCursor = 0
  mocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => (
    key in settings ? settings[key] : fallback
  ))
  mocks.setSetting.mockReset().mockResolvedValue(undefined)
}

/** Opens the dialog the way a user does, through the row button; the open flag is state, so it stays open. */
function openDialog() {
  mocks.buttonProps.length = 0
  render()
  const configureButton = mocks.buttonProps.find(({ ariaLabel }) => ariaLabel === CONFIGURE_SAVING)
  expect(configureButton, CONFIGURE_SAVING).toBeDefined()
  configureButton?.onClick?.()
}

/** Renders, runs the load effect, waits for it, then renders again with the dialog open unless told not to. */
async function renderLoaded(settings: Record<string, unknown> = {}, { dialog = true }: { dialog?: boolean } = {}) {
  resetHarness(settings)
  render()
  mocks.effects[0]?.()
  await tick()
  if (dialog) openDialog()
  mocks.switchProps.length = 0
  mocks.buttonProps.length = 0
  return render()
}

const alertsContaining = (markup: string, message: string) =>
  markup.match(new RegExp(`<p role="alert"[^>]*>${message.replace('.', '\\.')}</p>`, 'g'))?.length ?? 0

beforeEach(() => {
  active = false
  pending = false
  onPendingChange.mockReset()
  mocks.resolveDir.mockReset().mockResolvedValue('C:/Users/test/Documents/SayIt/Subtitles')
  mocks.openFolder.mockReset().mockResolvedValue(undefined)
  mocks.pickFolder.mockReset().mockResolvedValue(null)
  mocks.addRuntimeEvent.mockReset()
})

describe('saving row', () => {
  it('keeps the dialog closed and the summary empty until the saved values have loaded', async () => {
    resetHarness()
    const beforeLoad = render()
    mocks.effects[0]?.()
    await tick()
    const loaded = render()

    for (const markup of [beforeLoad, loaded]) {
      expect(markup).toContain(`aria-label="${CONFIGURE_SAVING}"`)
      expect(markup).not.toContain('role="dialog"')
    }
    expect(beforeLoad).not.toMatch(/>Off</)
    expect(loaded).toMatch(/>Off</)
  })

  it('names the folder in the summary once the journal is on and the folder is resolved', async () => {
    mocks.resolveDir.mockResolvedValue('D:/journals')
    const markup = await renderLoaded({ 'systemAudio.transcriptEnabled': true, 'systemAudio.transcriptDir': 'D:/journals' }, { dialog: false })

    expect(markup).toContain('Saving to D:/journals')
    expect(markup).not.toMatch(/>Off</)
  })

  it('only says the journal is on while the folder cannot be resolved', async () => {
    mocks.resolveDir.mockRejectedValue(new Error('no such folder'))
    const markup = await renderLoaded({ 'systemAudio.transcriptEnabled': true }, { dialog: false })

    expect(markup).toMatch(/>On</)
    expect(markup).not.toContain('Saving to')
    expect(mocks.addRuntimeEvent).toHaveBeenCalledWith('warn', 'system-audio', 'Could not resolve the transcript folder for display', { error: 'Error: no such folder' })
  })

  it('shows a load failure under the row, keeps the controls locked, and logs it', async () => {
    resetHarness()
    mocks.getSetting.mockRejectedValue(new Error('store unavailable'))
    render()
    mocks.effects[0]?.()
    await tick()

    let markup = render()
    expect(alertsContaining(markup, loadFailedMessage)).toBe(1)
    expect(markup).not.toMatch(/>Off</)
    expect(mocks.addRuntimeEvent).toHaveBeenCalledWith('warn', 'system-audio', 'Could not load the subtitle saving settings', { error: 'Error: store unavailable' })

    openDialog()
    mocks.switchProps.length = 0
    markup = render()
    expect(mocks.switchProps.find(({ label }) => label === journalLabel)).toMatchObject({ checked: false, disabled: true })
    expect(alertsContaining(markup, loadFailedMessage)).toBe(2)
    expect(markup.indexOf(loadFailedMessage)).toBeLessThan(markup.indexOf('role="dialog"'))
  })
})

describe('saving dialog', () => {
  it('shows the saved journal folder and persists the switch without writing other settings', async () => {
    mocks.resolveDir.mockResolvedValue('D:/journals')
    const markup = await renderLoaded({ 'systemAudio.transcriptEnabled': true, 'systemAudio.transcriptDir': 'D:/journals' })

    expect(markup).toContain('D:/journals')
    expect(mocks.resolveDir).toHaveBeenCalledWith('D:/journals')
    const journalSwitch = mocks.switchProps.find(({ label }) => label === journalLabel)
    expect(journalSwitch).toMatchObject({ checked: true, disabled: false })
    expect(mocks.setSetting).not.toHaveBeenCalled()

    journalSwitch?.onChange()
    expect(mocks.setSetting).toHaveBeenCalledExactlyOnceWith('systemAudio.transcriptEnabled', false)
    await tick()
    mocks.switchProps.length = 0
    render()
    expect(mocks.switchProps.find(({ label }) => label === journalLabel)).toMatchObject({ checked: false, disabled: false })
  })

  it('keeps the journal switch disabled until its saved value has loaded', async () => {
    let resolveTranscriptLoad!: (value: boolean) => void
    const pendingLoad = new Promise<boolean>((resolve) => { resolveTranscriptLoad = resolve })
    resetHarness()
    mocks.getSetting.mockReset().mockImplementation((key: string, fallback: unknown) => (
      key === 'systemAudio.transcriptEnabled' ? pendingLoad : Promise.resolve(fallback)
    ))

    render()
    mocks.effects[0]?.()
    await Promise.resolve()
    openDialog()
    mocks.switchProps.length = 0
    render()
    const duringLoad = mocks.switchProps.find(({ label }) => label === journalLabel)

    expect(duringLoad).toMatchObject({ checked: false, disabled: true })
    duringLoad?.onChange()
    expect(mocks.setSetting).not.toHaveBeenCalled()

    resolveTranscriptLoad(true)
    await tick()

    mocks.switchProps.length = 0
    render()
    expect(mocks.switchProps.find(({ label }) => label === journalLabel)).toMatchObject({ checked: true, disabled: false })
  })

  it('keeps the saved state and repeats the error in the dialog when the journal toggle write fails', async () => {
    await renderLoaded()
    mocks.setSetting.mockRejectedValueOnce(new Error('write failed'))
    const journalSwitch = mocks.switchProps.find(({ label }) => label === journalLabel)
    expect(journalSwitch).toMatchObject({ checked: false, disabled: false })

    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
    const processEvents = Reflect.get(globalThis, 'process') as {
      on: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
      off: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
    }
    processEvents.on('unhandledRejection', onUnhandledRejection)
    try {
      journalSwitch?.onChange()
      await tick()
      expect(mocks.setSetting).toHaveBeenCalledExactlyOnceWith('systemAudio.transcriptEnabled', true)
      expect(unhandledRejections).toEqual([])

      mocks.switchProps.length = 0
      const markup = render()
      expect(mocks.switchProps.find(({ label }) => label === journalLabel)).toMatchObject({ checked: false, disabled: false })
      // Once under the row and once in the dialog, where the row copy is behind the backdrop.
      expect(alertsContaining(markup, saveFailedMessage)).toBe(2)
      expect(markup.indexOf(saveFailedMessage)).toBeLessThan(markup.indexOf('role="dialog"'))
      expect(markup.lastIndexOf(saveFailedMessage)).toBeGreaterThan(markup.indexOf('role="dialog"'))
    } finally {
      processEvents.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('opens the configured transcript folder and reports a failure', async () => {
    await renderLoaded()

    const openButton = mocks.buttonProps.find(({ children }) => children === 'Open folder')
    expect(openButton).toBeDefined()
    openButton?.onClick?.()
    await tick()
    expect(mocks.openFolder).toHaveBeenCalledExactlyOnceWith('')

    mocks.openFolder.mockRejectedValueOnce(new Error('explorer failed'))
    mocks.buttonProps.length = 0
    render()
    mocks.buttonProps.find(({ children }) => children === 'Open folder')?.onClick?.()
    await tick()

    const markup = render()
    expect(markup).toMatch(/<p role="alert"[^>]*>[^<]+<\/p>/)
    expect(markup).toContain('Could not open the transcript folder.')
  })

  it('writes the picked folder and shows its resolved path', async () => {
    await renderLoaded()
    mocks.pickFolder.mockResolvedValue('E:/picked')
    mocks.resolveDir.mockResolvedValue('E:/picked')

    mocks.buttonProps.find(({ children }) => children === 'Choose folder…')?.onClick?.()
    await tick()

    expect(mocks.pickFolder).toHaveBeenCalled()
    expect(mocks.setSetting).toHaveBeenCalledExactlyOnceWith('systemAudio.transcriptDir', 'E:/picked')
    const markup = render()
    expect(markup).toContain('E:/picked')
  })
})

describe('page contract', () => {
  it('reports a settings write to the page: busy while it runs, idle once it settles', async () => {
    let completeWrite!: () => void
    await renderLoaded()
    mocks.setSetting.mockReturnValueOnce(new Promise<void>((resolve) => { completeWrite = resolve }))

    mocks.switchProps.find(({ label }) => label === journalLabel)?.onChange()
    expect(onPendingChange.mock.calls).toEqual([[true]])

    completeWrite()
    await tick()
    expect(onPendingChange.mock.calls).toEqual([[true], [false]])
  })

  it('still reports idle after a failed write', async () => {
    await renderLoaded()
    mocks.setSetting.mockRejectedValueOnce(new Error('write failed'))

    mocks.switchProps.find(({ label }) => label === journalLabel)?.onChange()
    await tick()
    expect(onPendingChange.mock.calls).toEqual([[true], [false]])
  })

  it.each([
    ['while a session is active', () => { active = true }],
    ['while another page action is pending', () => { pending = true }],
  ])('stays read-only %s', async (_name, lock) => {
    lock()
    await renderLoaded({ 'systemAudio.transcriptEnabled': true })

    const journalSwitch = mocks.switchProps.find(({ label }) => label === journalLabel)
    expect(journalSwitch).toMatchObject({ checked: true, disabled: true })
    journalSwitch?.onChange()
    expect(mocks.setSetting).not.toHaveBeenCalled()
    expect(onPendingChange).not.toHaveBeenCalled()
    for (const label of ['Choose folder…', 'Open folder']) {
      expect(mocks.buttonProps.find(({ children }) => children === label), label).toMatchObject({ disabled: true })
    }
  })
})

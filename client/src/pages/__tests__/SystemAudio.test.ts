import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefault } from '@/services/defaults'
import { getSystemAudioDualSubtitles, listSystemAudioDevices, systemAudioSession } from '@/services/systemAudio'
import { getWorkMode } from '@/services/transcription'
import SystemAudio, { buildTranslationOptions, defaultSubtitleTargetLanguage, SystemAudioControls } from '../SystemAudio'
import type { SelectOption } from '@/components/ui/select'
import type { PromptPreset } from '@/services/store'

const pageMocks = vi.hoisted(() => ({
  switchProps: [] as Array<{ checked: boolean; disabled?: boolean; label?: string; labelledBy?: string; onChange: () => void }>,
  buttonProps: [] as Array<{ children?: unknown; ariaLabel?: string; disabled?: boolean; onClick?: (event?: unknown) => void }>,
  effects: [] as Array<() => void | (() => void)>,
  stateValues: [] as unknown[],
  stateCursor: 0,
  getSetting: vi.fn(),
  getPromptPresets: vi.fn(),
  setSetting: vi.fn(),
  loadActiveAsrProfile: vi.fn(),
}))

vi.mock('@/services/transcription', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/transcription')>()
  return { ...actual, getWorkMode: vi.fn(() => 'cloud_api') }
})

vi.mock('@/features/settings/asrProfileStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/settings/asrProfileStore')>()
  return { ...actual, loadActiveAsrProfile: pageMocks.loadActiveAsrProfile }
})

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initial: T): [T, (next: T | ((previous: T) => T)) => void] => {
      const index = pageMocks.stateCursor++
      if (!(index in pageMocks.stateValues)) pageMocks.stateValues[index] = initial
      return [pageMocks.stateValues[index] as T, (next) => {
        pageMocks.stateValues[index] = typeof next === 'function'
          ? (next as (previous: T) => T)(pageMocks.stateValues[index] as T)
          : next
      }]
    },
    useEffect: (effect: () => void | (() => void)) => {
      pageMocks.effects.push(effect)
    },
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useLayoutEffect: () => undefined,
  }
})

vi.mock('@/services/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/store')>()
  return {
    ...actual,
    getSetting: pageMocks.getSetting,
    getPromptPresets: pageMocks.getPromptPresets,
    setSetting: pageMocks.setSetting,
  }
})

vi.mock('@/services/systemAudio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/systemAudio')>()
  return {
    ...actual,
    listSystemAudioDevices: vi.fn().mockResolvedValue([]),
    getSystemAudioSourceLanguage: vi.fn().mockResolvedValue('auto'),
    getSystemAudioMaxSegmentSeconds: vi.fn().mockResolvedValue(6),
    getSystemAudioDualSubtitles: vi.fn().mockResolvedValue(false),
  }
})

vi.mock('@/components/ui/switch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/switch')>()
  const React = await import('react')
  return {
    ...actual,
    Switch: (props: Parameters<typeof actual.Switch>[0]) => {
      pageMocks.switchProps.push(props)
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
      pageMocks.buttonProps.push({
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

beforeEach(() => {
  vi.mocked(getWorkMode).mockReturnValue('cloud_api')
  pageMocks.loadActiveAsrProfile.mockReset()
  pageMocks.loadActiveAsrProfile.mockResolvedValue({
    id: 'deepgram-account',
    provider: 'deepgram',
    model: 'nova-3',
    apiKey: 'key',
  })
  pageMocks.buttonProps.length = 0
})

const CONFIGURE_CAPTIONS = 'Configure captions'
const CONFIGURE_SAVING = 'Configure saving subtitles'
const CONFIGURE_DIAGNOSTICS = 'Configure diagnostics'

/** The markup of a settings row's button, found by the accessible name that names its action. */
const settingsRow = (markup: string, configureLabel: string) => markup.match(new RegExp(`<button\\b[^>]*aria-label="${configureLabel}"[\\s\\S]*?</button>`))?.[0] ?? ''
const diagnosticsRow = (markup: string) => settingsRow(markup, CONFIGURE_DIAGNOSTICS)

/**
 * Opens a settings dialog the way a user does, through its row button. The open dialog is page
 * state, so it stays open for the renders that follow. The page must already be rendered once.
 */
function openSettingsDialog(configureLabel: string) {
  pageMocks.buttonProps.length = 0
  pageMocks.stateCursor = 0
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
  const configureButton = pageMocks.buttonProps.find(({ ariaLabel }) => ariaLabel === configureLabel)
  expect(configureButton, configureLabel).toBeDefined()
  configureButton?.onClick?.()
  pageMocks.stateCursor = 0
}

describe('system audio translation options', () => {
  it('derives language values from builtin translate presets only', () => {
    const presets: PromptPreset[] = [
      { id: 'translate_de', name: 'Translate to German', systemPrompt: 'German translation', builtin: true },
      { id: 'translate_xx', name: 'Custom translation', systemPrompt: 'Custom translation', builtin: false },
      { id: 'casual', name: 'Conversational cleanup', systemPrompt: 'Casual cleanup', builtin: true },
    ]

    expect(buildTranslationOptions(presets)).toEqual([{ value: 'de', label: 'Translate to German' }])
  })
})

describe('default subtitle target language', () => {
  const options: SelectOption[] = [
    { value: 'uk', label: 'Ukrainian' },
    { value: 'en', label: 'English' },
    { value: 'ru', label: 'Russian' },
  ]

  it('selects English when it matches the interface locale', () => {
    expect(defaultSubtitleTargetLanguage(options, 'en')).toBe('en')
  })

  it('selects Ukrainian when it matches the interface locale', () => {
    expect(defaultSubtitleTargetLanguage(options, 'uk')).toBe('uk')
  })

  it('selects the first option when the interface locale is not offered', () => {
    expect(defaultSubtitleTargetLanguage(options, 'de')).toBe('uk')
  })

  it('returns an empty value when no translation options are available', () => {
    expect(defaultSubtitleTargetLanguage([], 'en')).toBe('')
  })
})

describe('subtitle session controls', () => {
  it.each([
    { state: 'idle', action: 'Start subtitles', excluded: 'Pause' },
    { state: 'listening', action: 'Pause', excluded: 'Start subtitles' },
    { state: 'paused', action: 'Resume', excluded: 'Start subtitles' },
    { state: 'error', action: 'Resume', excluded: 'Start subtitles' },
  ] as const)('exposes the action belonging to the actual $state session', ({ state, action, excluded }) => {
    const markup = renderToStaticMarkup(createElement(SystemAudioControls, { state, busy: false, onAction: () => undefined }))
    expect(markup).toContain(action)
    expect(markup).not.toContain(excluded)
    if (state !== 'idle') expect(markup).toContain('Stop and return to dictation')
  })

  it('shows a short Stop label and keeps the full action as its accessible name and hint', () => {
    const markup = renderToStaticMarkup(createElement(SystemAudioControls, { state: 'listening', busy: false, onAction: () => undefined }))
    const stopButton = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
      .map(([buttonMarkup]) => buttonMarkup)
      .find((buttonMarkup) => buttonMarkup.includes('aria-label="Stop and return to dictation"'))

    expect(stopButton).toContain('title="Stop and return to dictation"')
    expect(stopButton).toMatch(/<\/svg>Stop<\/button>$/)
  })

  it('keeps Stop available during startup but prevents duplicate stop requests during handback', () => {
    for (const state of ['starting', 'stopping'] as const) {
      const markup = renderToStaticMarkup(createElement(SystemAudioControls, { state, busy: true, onAction: () => undefined }))
      expect(markup).toContain('Stop and return to dictation')
      expect(markup.includes('disabled=""')).toBe(state === 'stopping')
    }
  })
})

describe('live system-audio recognition setting', () => {
  it('defaults off and persists the independent page switch without changing other modes', async () => {
    expect(getDefault('systemAudio.liveRecognitionEnabled')).toBe(false)

    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.effects.length = 0
    pageMocks.getSetting.mockReset().mockImplementation(async (_key: string, fallback: unknown) => fallback)
    pageMocks.getPromptPresets.mockResolvedValue([])
    pageMocks.setSetting.mockReset().mockResolvedValue(undefined)
    const initialMarkup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    expect(initialMarkup).not.toContain('Live computer-audio recognition')

    pageMocks.effects[0]?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    openSettingsDialog(CONFIGURE_CAPTIONS)
    pageMocks.stateCursor = 0
    pageMocks.switchProps.length = 0
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    expect(pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition'))
      .toMatchObject({ checked: false, disabled: false })
    expect(markup).toContain('Live computer-audio recognition')
    pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')?.onChange()

    expect(pageMocks.setSetting).toHaveBeenCalledTimes(1)
    expect(pageMocks.setSetting).toHaveBeenCalledWith('systemAudio.liveRecognitionEnabled', true)
  })

  it('offers the live-recognition setting only while Deepgram is the active cloud profile', async () => {
    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.getSetting.mockReset().mockImplementation(async (_key: string, fallback: unknown) => fallback)
    pageMocks.getPromptPresets.mockResolvedValue([])
    pageMocks.setSetting.mockReset().mockResolvedValue(undefined)
    vi.mocked(listSystemAudioDevices).mockResolvedValue([])
    pageMocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'doubao-account',
      provider: 'doubao_v2',
      model: 'Doubao-Seed-ASR-2.0',
      apiKey: 'key',
    })

    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.effects[0]?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    openSettingsDialog(CONFIGURE_CAPTIONS)

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    let markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    // The dialog is open (its other switch renders), so the missing live switch is the profile gate and not a closed dialog.
    expect(pageMocks.switchProps.some(({ label }) => label === 'Show original and translation')).toBe(true)
    expect(markup).not.toContain('Live computer-audio recognition')
    expect(pageMocks.switchProps.some(({ label }) => label === 'Live computer-audio recognition')).toBe(false)

    pageMocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'deepgram-account',
      provider: 'deepgram',
      model: 'nova-3',
      apiKey: 'key',
    })
    vi.mocked(getWorkMode).mockReturnValue('local')
    pageMocks.effects[0]?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    expect(pageMocks.switchProps.some(({ label }) => label === 'Show original and translation')).toBe(true)
    expect(markup).not.toContain('Live computer-audio recognition')
    expect(pageMocks.switchProps.some(({ label }) => label === 'Live computer-audio recognition')).toBe(false)
  })

  it('loads the saved opt-in into page state without writing other subtitle settings', async () => {
    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.getSetting.mockClear()
    pageMocks.getSetting.mockImplementation(async (key: string, fallback: unknown) => (
      key === 'systemAudio.liveRecognitionEnabled' ? true : fallback
    ))
    pageMocks.getPromptPresets.mockResolvedValue([])
    pageMocks.setSetting.mockClear()

    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.effects[0]?.()
    await Promise.resolve()
    await Promise.resolve()
    openSettingsDialog(CONFIGURE_CAPTIONS)

    expect(pageMocks.getSetting).toHaveBeenCalledWith('systemAudio.liveRecognitionEnabled', false)
    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    const liveSwitchMarkup = [...markup.matchAll(/<button\b[^>]*role="switch"[^>]*>[\s\S]*?<\/button>/g)]
      .map(([switchMarkup]) => switchMarkup)
      .find((switchMarkup) => switchMarkup.includes('Live computer-audio recognition'))

    expect(liveSwitchMarkup).toContain('aria-checked="true"')
    expect(pageMocks.setSetting).not.toHaveBeenCalled()
  })

  it('reverts the live switch and shows the page error when persistence rejects', async () => {
    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => (
      key === 'systemAudio.liveRecognitionEnabled' ? true : fallback
    ))
    pageMocks.getPromptPresets.mockResolvedValue([])
    vi.mocked(listSystemAudioDevices).mockResolvedValue([])
    pageMocks.setSetting.mockReset().mockRejectedValue(new Error('write failed'))

    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.effects[0]?.()
    await Promise.resolve()
    await Promise.resolve()
    openSettingsDialog(CONFIGURE_CAPTIONS)

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    const liveSwitch = pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')

    const unhandledRejections: unknown[] = []
    const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason)
    const processEvents = Reflect.get(globalThis, 'process') as {
      on: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
      off: (event: 'unhandledRejection', listener: (reason: unknown) => void) => void
    }
    processEvents.on('unhandledRejection', onUnhandledRejection)
    try {
      liveSwitch?.onChange()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      expect(pageMocks.setSetting).toHaveBeenCalledWith('systemAudio.liveRecognitionEnabled', false)
      expect(unhandledRejections).toEqual([])

      pageMocks.switchProps.length = 0
      pageMocks.stateCursor = 0
      const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
      const liveSwitchMarkup = [...markup.matchAll(/<button\b[^>]*role="switch"[^>]*>[\s\S]*?<\/button>/g)]
        .map(([switchMarkup]) => switchMarkup)
        .find((switchMarkup) => switchMarkup.includes('Live computer-audio recognition'))

      expect(liveSwitchMarkup).toContain('aria-checked="true"')
      expect(markup).toMatch(/<p role="alert"[^>]*>[^<]+<\/p>/)
    } finally {
      processEvents.off('unhandledRejection', onUnhandledRejection)
    }
  })

  it('preserves the initial load error and disabled Start after a live-setting write succeeds', async () => {
    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => (
      key === 'systemAudio.liveRecognitionEnabled' ? true : fallback
    ))
    pageMocks.getPromptPresets.mockResolvedValue([])
    vi.mocked(listSystemAudioDevices).mockRejectedValue(new Error('device list failed'))
    pageMocks.setSetting.mockReset().mockResolvedValue(undefined)

    try {
      renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
      pageMocks.effects[0]?.()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      openSettingsDialog(CONFIGURE_CAPTIONS)

      pageMocks.switchProps.length = 0
      pageMocks.stateCursor = 0
      const initialMarkup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
      const initialAlert = initialMarkup.match(/<p role="alert"[^>]*>[^<]+<\/p>/)?.[0]
      expect(initialAlert).toBeDefined()
      const liveSwitch = pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')
      expect(liveSwitch).toMatchObject({ checked: true, disabled: false })
      liveSwitch!.onChange()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))

      expect(pageMocks.setSetting).toHaveBeenCalledExactlyOnceWith('systemAudio.liveRecognitionEnabled', false)
      pageMocks.switchProps.length = 0
      pageMocks.stateCursor = 0
      const savedMarkup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
      expect(pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition'))
        .toMatchObject({ checked: false, disabled: false })
      for (const markup of [initialMarkup, savedMarkup]) {
        expect(markup).toContain(initialAlert!)
        const startButton = [...markup.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
          .find(([buttonMarkup]) => buttonMarkup.includes('Start subtitles'))?.[0]
        expect(startButton).toContain('disabled=""')
      }
    } finally {
      vi.mocked(listSystemAudioDevices).mockResolvedValue([])
    }
  })

  it('keeps the live switch disabled until its saved value has loaded', async () => {
    let persistedLiveRecognition = false
    let resolveLiveRecognitionLoad!: (value: boolean) => void
    const savedLiveRecognitionLoad = new Promise<boolean>((resolve) => {
      resolveLiveRecognitionLoad = resolve
    })

    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    vi.mocked(listSystemAudioDevices).mockResolvedValue([])
    pageMocks.getSetting.mockReset()
    pageMocks.getSetting.mockImplementation((key: string, fallback: unknown) => (
      key === 'systemAudio.liveRecognitionEnabled' ? savedLiveRecognitionLoad : Promise.resolve(fallback)
    ))
    pageMocks.getPromptPresets.mockResolvedValue([])
    pageMocks.setSetting.mockReset()
    pageMocks.setSetting.mockImplementation(async (key: string, value: unknown) => {
      if (key === 'systemAudio.liveRecognitionEnabled') persistedLiveRecognition = value as boolean
    })

    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.effects[0]?.()
    await Promise.resolve()
    openSettingsDialog(CONFIGURE_CAPTIONS)
    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    const liveSwitchDuringLoad = pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')

    expect(liveSwitchDuringLoad).toMatchObject({ checked: false, disabled: true })
    liveSwitchDuringLoad?.onChange()
    expect(pageMocks.setSetting).not.toHaveBeenCalled()

    resolveLiveRecognitionLoad(false)
    await Promise.resolve()
    await Promise.resolve()

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    const liveSwitchMarkup = [...markup.matchAll(/<button\b[^>]*role="switch"[^>]*>[\s\S]*?<\/button>/g)]
      .map(([switchMarkup]) => switchMarkup)
      .find((switchMarkup) => switchMarkup.includes('Live computer-audio recognition'))

    expect(liveSwitchMarkup).toContain(`aria-checked="${persistedLiveRecognition}"`)
    expect(pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')?.disabled).toBe(false)
  })

  it('does not write the default value while the saved live setting is still loading', async () => {
    const persistedLiveRecognition = true
    let resolveLiveRecognitionLoad!: (value: boolean) => void
    const savedLiveRecognitionLoad = new Promise<boolean>((resolve) => {
      resolveLiveRecognitionLoad = resolve
    })
    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    vi.mocked(listSystemAudioDevices).mockResolvedValue([])
    pageMocks.getSetting.mockReset()
    pageMocks.getSetting.mockImplementation((key: string, fallback: unknown) => (
      key === 'systemAudio.liveRecognitionEnabled' ? savedLiveRecognitionLoad : Promise.resolve(fallback)
    ))
    pageMocks.getPromptPresets.mockResolvedValue([])
    pageMocks.setSetting.mockReset().mockResolvedValue(undefined)

    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.effects[0]?.()
    await Promise.resolve()
    openSettingsDialog(CONFIGURE_CAPTIONS)
    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    const liveSwitchDuringLoad = pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')

    expect(liveSwitchDuringLoad).toMatchObject({ checked: false, disabled: true })
    liveSwitchDuringLoad?.onChange()
    expect(pageMocks.setSetting).not.toHaveBeenCalled()
    resolveLiveRecognitionLoad(persistedLiveRecognition)
    await Promise.resolve()
    await Promise.resolve()

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    const liveSwitchMarkup = [...markup.matchAll(/<button\b[^>]*role="switch"[^>]*>[\s\S]*?<\/button>/g)]
      .map(([switchMarkup]) => switchMarkup)
      .find((switchMarkup) => switchMarkup.includes('Live computer-audio recognition'))
    const visibleLiveRecognition = liveSwitchMarkup?.match(/aria-checked="(true|false)"/)?.[1]

    expect(visibleLiveRecognition).toBe(String(persistedLiveRecognition))
  })

  it('disables the live switch and keeps the saved value visible until a write succeeds', async () => {
    let completeWrite!: () => void
    const write = new Promise<void>((resolve) => { completeWrite = resolve })
    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.getSetting.mockReset().mockImplementation(async (_key: string, fallback: unknown) => fallback)
    pageMocks.getPromptPresets.mockResolvedValue([])
    pageMocks.setSetting.mockReset().mockReturnValue(write)
    vi.mocked(listSystemAudioDevices).mockResolvedValue([])

    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.effects[0]?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    openSettingsDialog(CONFIGURE_CAPTIONS)
    pageMocks.stateCursor = 0
    pageMocks.switchProps.length = 0
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')?.onChange()

    pageMocks.stateCursor = 0
    pageMocks.switchProps.length = 0
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    const pendingSwitch = pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')
    expect(pendingSwitch).toMatchObject({ checked: false, disabled: true })
    pendingSwitch?.onChange()
    expect(pageMocks.setSetting).toHaveBeenCalledTimes(1)

    completeWrite()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    pageMocks.stateCursor = 0
    pageMocks.switchProps.length = 0
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    expect(pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition'))
      .toMatchObject({ checked: true, disabled: false })
  })

  it('clears a live-setting write error only after a later write succeeds', async () => {
    let completeSuccessfulWrite!: () => void
    const successfulWritePending = new Promise<void>((resolve) => {
      completeSuccessfulWrite = resolve
    })

    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    vi.mocked(listSystemAudioDevices).mockResolvedValue([])
    pageMocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => (
      key === 'systemAudio.liveRecognitionEnabled' ? false : fallback
    ))
    pageMocks.getPromptPresets.mockResolvedValue([])
    pageMocks.setSetting.mockReset()
      .mockRejectedValueOnce(new Error('write failed'))
      .mockReturnValueOnce(successfulWritePending)

    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.effects[0]?.()
    await Promise.resolve()
    await Promise.resolve()
    openSettingsDialog(CONFIGURE_CAPTIONS)

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')?.onChange()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    let markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    expect(markup).toMatch(/<p role="alert"[^>]*>[^<]+<\/p>/)

    pageMocks.switchProps.find(({ label }) => label === 'Live computer-audio recognition')?.onChange()
    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    expect(markup).toMatch(/<p role="alert"[^>]*>[^<]+<\/p>/)

    completeSuccessfulWrite()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
    expect(markup).not.toMatch(/<p role="alert"/)
  })

  it('keeps the live original separate from the settled source and caption on the page', () => {
    const current = systemAudioSession.getSnapshot()
    const snapshot = {
      ...current,
      liveRecognition: true,
      liveOriginal: 'Current live phrase',
      source: 'Settled original',
      caption: 'Settled translation',
    }
    const getSnapshot = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue(snapshot)

    try {
      const markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
      const liveIndex = markup.indexOf('Current live phrase')
      const settledIndex = markup.indexOf('Settled original')

      expect(markup).toContain('Live original')
      expect(liveIndex).toBeGreaterThan(-1)
      expect(settledIndex).toBeGreaterThan(liveIndex)
      expect(markup).toContain('Settled translation')
      expect(markup.match(/aria-live="polite"/g)).toHaveLength(2)
    } finally {
      getSnapshot.mockRestore()
    }
  })
})

describe('settings rows and dialogs', () => {
  const page = () => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))

  async function renderRows(settings: Record<string, unknown> = {}, presets: PromptPreset[] = []) {
    pageMocks.effects.length = 0
    pageMocks.switchProps.length = 0
    pageMocks.buttonProps.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    pageMocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => (
      key in settings ? settings[key] : fallback
    ))
    pageMocks.getPromptPresets.mockResolvedValue(presets)
    pageMocks.setSetting.mockReset().mockResolvedValue(undefined)
    vi.mocked(listSystemAudioDevices).mockResolvedValue([])
    const beforeLoad = page()
    pageMocks.effects[0]?.()
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    pageMocks.stateCursor = 0
    // Keep the spy on the loaded render: the first pass still shows the pre-load defaults, and a
    // switch lookup must not match its stale props.
    pageMocks.switchProps.length = 0
    return { beforeLoad, loaded: page() }
  }

  it('keeps every dialog closed and the row summaries empty until the saved values have loaded', async () => {
    const { beforeLoad, loaded } = await renderRows()

    for (const markup of [beforeLoad, loaded]) {
      expect(markup).toContain('aria-label="Configure captions"')
      expect(markup).toContain('aria-label="Configure saving subtitles"')
      expect(markup).toContain('aria-label="Configure diagnostics"')
      expect(markup).not.toContain('role="dialog"')
    }
    expect(beforeLoad).not.toContain('Up to ')
    expect(loaded).toContain('Up to 6s · translation only')
    expect(diagnosticsRow(beforeLoad)).not.toContain('>Off<')
    expect(diagnosticsRow(loaded)).toContain('>Off<')
  })

  it('marks the page title with the shared alpha badge', async () => {
    const { loaded } = await renderRows()

    const titleStart = loaded.indexOf('Translate computer audio')
    expect(titleStart).toBeGreaterThan(-1)
    const title = loaded.slice(titleStart, loaded.indexOf('</h1>', titleStart))
    expect(title).toContain('<svg')
    expect(title).toContain('sr-only">Alpha<')
  })

  it('summarises what will run: original above translation and live recognition', async () => {
    vi.mocked(getSystemAudioDualSubtitles).mockResolvedValueOnce(true)
    const { loaded } = await renderRows({ 'systemAudio.liveRecognitionEnabled': true })

    expect(loaded).toContain('Up to 6s · original above translation · live recognition')
  })

  it('reports recognition-only mode and leaves out live recognition the profile cannot offer', async () => {
    vi.mocked(getSystemAudioDualSubtitles).mockResolvedValueOnce(true)
    pageMocks.loadActiveAsrProfile.mockResolvedValue({
      id: 'doubao-account',
      provider: 'doubao_v2',
      model: 'Doubao-Seed-ASR-2.0',
      apiKey: 'key',
    })
    const { loaded } = await renderRows({
      'systemAudio.asrOnlyTest': true,
      'systemAudio.liveRecognitionEnabled': true,
    })

    expect(loaded).toContain('Up to 6s · recognition only')
    expect(loaded).not.toContain('original above translation')
    expect(loaded).not.toContain('live recognition')
  })

  it('opens the captions dialog from its row button', async () => {
    await renderRows()

    openSettingsDialog(CONFIGURE_CAPTIONS)
    const markup = page()
    expect(markup).toContain('role="dialog" aria-label="Captions"')
    expect(markup).toContain('Maximum caption length')
    expect(markup).not.toContain('Journal folder')
  })

  it('opens the saving dialog from its row button, which belongs to the saving component', async () => {
    await renderRows()

    openSettingsDialog(CONFIGURE_SAVING)
    const markup = page()
    expect(markup).toContain('role="dialog" aria-label="Saving subtitles"')
    expect(markup).toContain('Journal folder')
    expect(markup).not.toContain('Maximum caption length')
  })

  it('opens the diagnostics dialog from its row button instead of expanding the page', async () => {
    await renderRows()

    openSettingsDialog(CONFIGURE_DIAGNOSTICS)
    const markup = page()
    expect(markup).toContain('role="dialog" aria-label="Diagnostics"')
    expect(markup).toContain('Pipeline debug')
    expect(markup).toContain('Recognition-only test mode')
    expect(markup).not.toContain('Maximum caption length')
    expect(markup).not.toContain('Journal folder')
  })

  it('names the diagnostics that are on in the row summary without opening the dialog', async () => {
    const { loaded } = await renderRows({
      'systemAudio.debugPipeline': true,
      'systemAudio.asrOnlyTest': true,
      'systemAudio.deepgramLeadingContext': true,
    })

    expect(loaded).not.toContain('role="dialog"')
    expect(diagnosticsRow(loaded)).toContain('>Pipeline debug · Recognition-only test · Deepgram overlap<')
  })

  it('does not take the saving settings into the page-level alert or its load', async () => {
    const { loaded } = await renderRows()

    expect(loaded).not.toMatch(/<p role="alert"/)
    expect(pageMocks.getSetting).not.toHaveBeenCalledWith('systemAudio.transcriptEnabled', expect.anything())
    expect(pageMocks.getSetting).not.toHaveBeenCalledWith('systemAudio.transcriptDir', expect.anything())
  })

  it('renders the idle session bar with the mode badge inside the header', async () => {
    const { loaded } = await renderRows()

    const header = loaded.slice(loaded.indexOf('<header'), loaded.indexOf('</header>'))
    expect(header).toContain('Cloud API mode')
    for (const text of [
      'Output device',
      'Audio language',
      'Translation language',
      'Start subtitles',
      'Dictation available',
      'Microphone dictation is unavailable while subtitles run.',
    ]) {
      expect(loaded).toContain(text)
    }
    expect(loaded).not.toContain('Locked while subtitles run')
  })

  it('locks the running session into a status row and read-only chips', async () => {
    const presets: PromptPreset[] = [{ id: 'translate_uk', name: 'x', systemPrompt: 'x', builtin: true }]
    await renderRows({ 'systemAudio.targetLanguage': 'uk' }, presets)
    const current = systemAudioSession.getSnapshot()
    const getSnapshot = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue({ ...current, state: 'listening' })

    try {
      pageMocks.stateCursor = 0
      const markup = page()
      expect(markup).toContain('Listening to computer audio')
      expect(markup).toContain('Pause')
      expect(markup).toContain('Stop and return to dictation')
      expect(markup).toContain('Locked while subtitles run')
      expect(markup).toContain('System default device (resolved at session start)')
      expect(markup).toContain('>Auto<')
      expect(markup).toContain('>Ukrainian<')
      expect(markup).not.toContain('Translate to Ukrainian')
      expect(markup).not.toContain('Start subtitles')
      expect(markup).not.toContain('id="subtitle-output-label"')
    } finally {
      getSnapshot.mockRestore()
    }
  })

  it('leaves the session chips out until the saved values have loaded', () => {
    pageMocks.effects.length = 0
    pageMocks.stateValues.length = 0
    pageMocks.stateCursor = 0
    const current = systemAudioSession.getSnapshot()
    const getSnapshot = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue({ ...current, state: 'listening' })

    try {
      const markup = page()
      expect(markup).toContain('Locked while subtitles run')
      expect(markup).not.toContain('System default device (resolved at session start)')
      expect(markup).not.toContain('>Auto<')
    } finally {
      getSnapshot.mockRestore()
    }
  })

  it('shows recognition only in the language chip when the test mode is on', async () => {
    const presets: PromptPreset[] = [{ id: 'translate_uk', name: 'x', systemPrompt: 'x', builtin: true }]
    await renderRows({ 'systemAudio.targetLanguage': 'uk', 'systemAudio.asrOnlyTest': true }, presets)
    const current = systemAudioSession.getSnapshot()
    const getSnapshot = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue({ ...current, state: 'listening' })

    try {
      pageMocks.stateCursor = 0
      const markup = page()
      expect(markup).toContain('>recognition only<')
      expect(markup).not.toContain('>Ukrainian<')
    } finally {
      getSnapshot.mockRestore()
    }
  })

  it('shows a lock instead of a chevron on the settings rows while a session runs', async () => {
    const { loaded } = await renderRows()
    for (const label of [CONFIGURE_CAPTIONS, CONFIGURE_SAVING]) {
      expect(settingsRow(loaded, label)).toContain('lucide-chevron-right')
      expect(settingsRow(loaded, label)).not.toContain('lucide-lock')
    }

    const current = systemAudioSession.getSnapshot()
    const getSnapshot = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue({ ...current, state: 'listening' })
    try {
      pageMocks.stateCursor = 0
      const markup = page()
      for (const label of [CONFIGURE_CAPTIONS, CONFIGURE_SAVING]) {
        expect(settingsRow(markup, label)).toContain('lucide-lock')
        expect(settingsRow(markup, label)).not.toContain('lucide-chevron-right')
      }
      // The pipeline trace switch stays editable during a session, so this row is not locked as a whole.
      expect(diagnosticsRow(markup)).toContain('lucide-chevron-right')
      expect(diagnosticsRow(markup)).not.toContain('lucide-lock')
    } finally {
      getSnapshot.mockRestore()
    }
  })

  describe('experimental Deepgram overlap switch', () => {
    const LABEL = 'subtitle-diagnostics-overlap-label'
    const SETTING = 'systemAudio.deepgramLeadingContext'
    const switchByLabel = (labelId: string) => pageMocks.switchProps.find((props) => props.labelledBy === labelId)
    // The switches live in the diagnostics dialog, so every lookup first opens it through its row.
    async function renderWithDiagnosticsOpen(settings: Record<string, unknown> = {}) {
      const rendered = await renderRows(settings)
      openSettingsDialog(CONFIGURE_DIAGNOSTICS)
      pageMocks.switchProps.length = 0
      return { ...rendered, opened: page() }
    }

    it('is off by default, enabled for editing, and absent while the diagnostics dialog is closed', async () => {
      expect(getDefault(SETTING)).toBe(false)
      const { loaded, opened } = await renderWithDiagnosticsOpen()

      expect(loaded).not.toContain('Deepgram only: each fragment also gets the last second of the previous one')
      expect(opened).toContain('Deepgram only: each fragment also gets the last second of the previous one')
      expect(switchByLabel(LABEL)).toMatchObject({ checked: false, disabled: false })
      expect(pageMocks.setSetting).not.toHaveBeenCalled()
    })

    it('is hidden for an engine that cannot accept leading context', async () => {
      pageMocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'doubao-account',
        provider: 'doubao_v2',
        model: 'Doubao-Seed-ASR-2.0',
        apiKey: 'key',
      })

      const { opened } = await renderWithDiagnosticsOpen()

      // The dialog is open (its other switch renders), so the missing switch is the engine gate and not a closed dialog.
      expect(switchByLabel('subtitle-diagnostics-debug-label')).toBeDefined()
      expect(opened).not.toContain('Experimental: Deepgram overlap')
      expect(opened).not.toContain('Deepgram only: each fragment also gets the last second')
      expect(switchByLabel(LABEL)).toBeUndefined()
    })

    it('is hidden outside the Cloud API engine even with a Deepgram profile saved', async () => {
      vi.mocked(getWorkMode).mockReturnValue('server')

      const { opened } = await renderWithDiagnosticsOpen()

      expect(switchByLabel('subtitle-diagnostics-debug-label')).toBeDefined()
      expect(opened).not.toContain('Experimental: Deepgram overlap')
      expect(switchByLabel(LABEL)).toBeUndefined()
    })

    it('does not name a saved value in the summary when its switch cannot be shown', async () => {
      pageMocks.loadActiveAsrProfile.mockResolvedValue({
        id: 'doubao-account',
        provider: 'doubao_v2',
        model: 'Doubao-Seed-ASR-2.0',
        apiKey: 'key',
      })

      const { loaded } = await renderRows({ [SETTING]: true })

      expect(diagnosticsRow(loaded)).toContain('>Off<')
      expect(loaded).not.toContain('Deepgram overlap')
    })

    it('shows a saved "on" in the summary and in the dialog, which stays closed until opened', async () => {
      const { loaded, opened } = await renderWithDiagnosticsOpen({ [SETTING]: true })

      expect(pageMocks.getSetting).toHaveBeenCalledWith(SETTING, false)
      expect(loaded).not.toContain('role="dialog"')
      expect(diagnosticsRow(loaded)).toContain('>Deepgram overlap<')
      expect(opened).toContain('role="dialog" aria-label="Diagnostics"')
      expect(switchByLabel(LABEL)).toMatchObject({ checked: true, disabled: false })
    })

    it('saves the switch value when it is toggled', async () => {
      await renderWithDiagnosticsOpen()

      switchByLabel(LABEL)?.onChange()
      expect(pageMocks.setSetting).toHaveBeenCalledExactlyOnceWith(SETTING, true)
      pageMocks.stateCursor = 0
      pageMocks.switchProps.length = 0
      page()
      expect(switchByLabel(LABEL)).toMatchObject({ checked: true })

      switchByLabel(LABEL)?.onChange()
      expect(pageMocks.setSetting).toHaveBeenLastCalledWith(SETTING, false)
      expect(pageMocks.setSetting).toHaveBeenCalledTimes(2)
      pageMocks.stateCursor = 0
      pageMocks.switchProps.length = 0
      page()
      expect(switchByLabel(LABEL)).toMatchObject({ checked: false })
    })

    it('is locked while a subtitle session is active, because the session reads it at start', async () => {
      await renderWithDiagnosticsOpen({ [SETTING]: true })
      const current = systemAudioSession.getSnapshot()
      const getSnapshot = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue({ ...current, state: 'listening' })

      try {
        pageMocks.stateCursor = 0
        pageMocks.switchProps.length = 0
        page()
        expect(switchByLabel(LABEL)).toMatchObject({ checked: true, disabled: true })
        expect(switchByLabel('subtitle-diagnostics-asr-only-label')).toMatchObject({ disabled: true })
        // The trace switch only records diagnostics, so it stays available while a session runs.
        expect(switchByLabel('subtitle-diagnostics-debug-label')).toMatchObject({ disabled: false })
      } finally {
        getSnapshot.mockRestore()
      }
    })
  })
})

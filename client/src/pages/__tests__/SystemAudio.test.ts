import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefault } from '@/services/defaults'
import { listSystemAudioDevices, systemAudioSession } from '@/services/systemAudio'
import { getWorkMode } from '@/services/transcription'
import SystemAudio, { buildTranslationOptions, defaultSubtitleTargetLanguage, SystemAudioControls } from '../SystemAudio'
import type { SelectOption } from '@/components/ui/select'
import type { PromptPreset } from '@/services/store'

const pageMocks = vi.hoisted(() => ({
  switchProps: [] as Array<{ checked: boolean; disabled?: boolean; label?: string; onChange: () => void }>,
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

beforeEach(() => {
  vi.mocked(getWorkMode).mockReturnValue('cloud_api')
  pageMocks.loadActiveAsrProfile.mockReset()
  pageMocks.loadActiveAsrProfile.mockResolvedValue({
    id: 'deepgram-account',
    provider: 'deepgram',
    model: 'nova-3',
    apiKey: 'key',
  })
})

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

    pageMocks.switchProps.length = 0
    pageMocks.stateCursor = 0
    let markup = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(SystemAudio)))
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

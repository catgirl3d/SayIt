import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({
  waitForBackendTlsReady: vi.fn(),
  storeGet: vi.fn(),
  storeSetBackendUrl: vi.fn(),
  storeDeleteBackendUrl: vi.fn(),
}))
const nativeInvoke = vi.hoisted(() => vi.fn())

vi.mock('../bridge', () => bridge)
vi.mock('@tauri-apps/api/core', () => ({ invoke: nativeInvoke }))

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function loadRuntimeConfig(configureEnv?: () => void) {
  vi.resetModules()
  configureEnv?.()
  return import('../runtimeConfig')
}

async function flushMicrotasks() {
  await Promise.resolve()
  await Promise.resolve()
}

async function flushBootstrap() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('runtime backend configuration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bridge.waitForBackendTlsReady.mockResolvedValue(undefined)
    bridge.storeGet.mockResolvedValue(null)
    bridge.storeSetBackendUrl.mockResolvedValue(undefined)
    bridge.storeDeleteBackendUrl.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  async function initializeWithSavedUrl(savedUrl: string | null, configureEnv?: () => void) {
    const runtimeConfig = await loadRuntimeConfig(configureEnv)
    bridge.storeGet.mockResolvedValueOnce(savedUrl)
    await runtimeConfig.initRuntimeConfig()
    return runtimeConfig
  }

  it('forwards native TLS readiness to the registered command', async () => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    nativeInvoke.mockResolvedValueOnce(undefined)

    await actual.waitForBackendTlsReady()

    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith('wait_for_backend_tls_ready')
  })

  it('forwards a backend URL save to the dedicated command', async () => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    nativeInvoke.mockResolvedValueOnce(undefined)

    await actual.storeSetBackendUrl('https://custom.example')

    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith('store_set_backend_url', { url: 'https://custom.example' })
  })

  it('forwards a backend URL reset to the dedicated command', async () => {
    const actual = await vi.importActual<typeof import('../bridge')>('../bridge')
    nativeInvoke.mockResolvedValueOnce(undefined)

    await actual.storeDeleteBackendUrl()

    expect(nativeInvoke).toHaveBeenCalledExactlyOnceWith('store_delete_backend_url')
  })

  it('waits for native TLS readiness before reading the saved backend URL', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const readiness = deferred<void>()
    bridge.waitForBackendTlsReady.mockReturnValueOnce(readiness.promise)
    bridge.storeGet.mockResolvedValueOnce('https://saved.example///')

    const initialization = runtimeConfig.initRuntimeConfig()
    await Promise.resolve()

    expect(bridge.waitForBackendTlsReady).toHaveBeenCalledOnce()
    expect(bridge.storeGet).not.toHaveBeenCalled()

    readiness.resolve()
    await initialization

    expect(bridge.storeGet).toHaveBeenCalledExactlyOnceWith('backendBaseUrl')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://saved.example')
  })

  it('still reads and publishes the saved URL when native readiness fails', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const failure = new Error('TLS policy initialization failed')
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    bridge.waitForBackendTlsReady.mockRejectedValueOnce(failure)
    bridge.storeGet.mockResolvedValueOnce('https://saved.example')

    await expect(runtimeConfig.initRuntimeConfig()).resolves.toBeUndefined()

    expect(bridge.storeGet).toHaveBeenCalledExactlyOnceWith('backendBaseUrl')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://saved.example')
    expect(consoleError).toHaveBeenCalledExactlyOnceWith(
      '[runtimeConfig] Native TLS policy is unavailable; the custom-server certificate exception is disabled:',
      failure,
    )
  })

  it('rejects initialization and keeps the URL when the saved URL cannot be read', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const failure = new Error('database read failed')
    const initialUrl = runtimeConfig.getBackendBaseUrl()
    bridge.storeGet.mockRejectedValueOnce(failure)

    await expect(runtimeConfig.initRuntimeConfig()).rejects.toBe(failure)

    expect(runtimeConfig.getBackendBaseUrl()).toBe(initialUrl)
  })

  it('publishes a saved URL only after native storage acknowledges it', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const initialUrl = runtimeConfig.getBackendBaseUrl()
    const write = deferred<void>()
    bridge.storeSetBackendUrl.mockReturnValueOnce(write.promise)

    const saving = runtimeConfig.setBackendBaseUrl(' https://custom.example/// ')
    await flushMicrotasks()

    expect(bridge.storeSetBackendUrl).toHaveBeenCalledExactlyOnceWith('https://custom.example')
    expect(runtimeConfig.getBackendBaseUrl()).toBe(initialUrl)

    write.resolve()
    await expect(saving).resolves.toBe('https://custom.example')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://custom.example')
  })

  it('keeps the previous URL after a failed save and allows a later save to retry', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const initialUrl = runtimeConfig.getBackendBaseUrl()
    const failure = new Error('database write failed')
    bridge.storeSetBackendUrl.mockRejectedValueOnce(failure).mockResolvedValueOnce(undefined)

    await expect(runtimeConfig.setBackendBaseUrl('https://rejected.example')).rejects.toBe(failure)
    expect(runtimeConfig.getBackendBaseUrl()).toBe(initialUrl)

    await expect(runtimeConfig.setBackendBaseUrl('https://retried.example')).resolves.toBe('https://retried.example')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://retried.example')
  })

  it('serializes saves and preserves each operation result while writes are pending', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const initialUrl = runtimeConfig.getBackendBaseUrl()
    const firstWrite = deferred<void>()
    const secondWrite = deferred<void>()
    const secondStarted = deferred<void>()
    bridge.storeSetBackendUrl
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => {
        secondStarted.resolve()
        return secondWrite.promise
      })

    const firstSave = runtimeConfig.setBackendBaseUrl('https://first.example')
    const secondSave = runtimeConfig.setBackendBaseUrl('https://second.example')
    await flushMicrotasks()

    expect(bridge.storeSetBackendUrl).toHaveBeenCalledExactlyOnceWith('https://first.example')
    expect(runtimeConfig.getBackendBaseUrl()).toBe(initialUrl)

    firstWrite.resolve()
    await secondStarted.promise

    expect(bridge.storeSetBackendUrl).toHaveBeenNthCalledWith(2, 'https://second.example')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://first.example')

    secondWrite.resolve()
    await expect(firstSave).resolves.toBe('https://first.example')
    await expect(secondSave).resolves.toBe('https://second.example')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://second.example')
  })

  it('serializes initialization before a later save so stale initialization cannot win', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const readiness = deferred<void>()
    const storedRead = deferred<unknown>()
    const saveWrite = deferred<void>()
    const saveStarted = deferred<void>()
    bridge.waitForBackendTlsReady.mockReturnValueOnce(readiness.promise)
    bridge.storeGet.mockImplementationOnce(() => storedRead.promise)
    bridge.storeSetBackendUrl.mockImplementationOnce(() => {
      saveStarted.resolve()
      return saveWrite.promise
    })

    const initialization = runtimeConfig.initRuntimeConfig()
    const saving = runtimeConfig.setBackendBaseUrl('https://new.example')
    await Promise.resolve()
    expect(bridge.waitForBackendTlsReady).toHaveBeenCalledOnce()
    expect(bridge.storeGet).not.toHaveBeenCalled()

    readiness.resolve()
    await flushMicrotasks()
    expect(bridge.storeGet).toHaveBeenCalledExactlyOnceWith('backendBaseUrl')
    expect(bridge.storeSetBackendUrl).not.toHaveBeenCalled()

    storedRead.resolve('https://stale.example')
    await saveStarted.promise
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://stale.example')

    saveWrite.resolve()
    await expect(initialization).resolves.toBeUndefined()
    await expect(saving).resolves.toBe('https://new.example')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://new.example')
  })

  it('runs reset after a pending save and applies the default only after deletion succeeds', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const savedWrite = deferred<void>()
    const resetDelete = deferred<void>()
    bridge.storeSetBackendUrl.mockReturnValueOnce(savedWrite.promise)
    const resetStarted = deferred<void>()
    bridge.storeDeleteBackendUrl.mockImplementationOnce(() => {
      resetStarted.resolve()
      return resetDelete.promise
    })

    const saved = runtimeConfig.setBackendBaseUrl('https://saved.example')
    const reset = runtimeConfig.resetBackendBaseUrl()
    await flushMicrotasks()

    expect(bridge.storeSetBackendUrl).toHaveBeenCalledExactlyOnceWith('https://saved.example')
    expect(bridge.storeDeleteBackendUrl).not.toHaveBeenCalled()

    savedWrite.resolve()
    await resetStarted.promise
    expect(bridge.storeDeleteBackendUrl).toHaveBeenCalledOnce()
    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://saved.example')

    resetDelete.resolve()
    await expect(saved).resolves.toBe('https://saved.example')
    await expect(reset).resolves.toBe('')
    expect(runtimeConfig.getDefaultBackendBaseUrl()).toBe('')
    expect(runtimeConfig.getBackendBaseUrl()).toBe('')
  })

  it('keeps the saved URL after a failed reset deletion', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    await expect(runtimeConfig.setBackendBaseUrl('https://kept.example')).resolves.toBe('https://kept.example')
    const failure = new Error('database delete failed')
    bridge.storeDeleteBackendUrl.mockRejectedValueOnce(failure)

    await expect(runtimeConfig.resetBackendBaseUrl()).rejects.toBe(failure)

    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://kept.example')
  })

  it('queues persisted reads behind a pending save', async () => {
    const runtimeConfig = await loadRuntimeConfig()
    const savedWrite = deferred<void>()
    bridge.storeSetBackendUrl.mockReturnValueOnce(savedWrite.promise)
    bridge.storeGet.mockResolvedValueOnce('https://saved.example')

    const saving = runtimeConfig.setBackendBaseUrl('https://saved.example')
    const reading = runtimeConfig.getStoredBackendBaseUrl()
    await flushMicrotasks()

    expect(bridge.storeGet).not.toHaveBeenCalled()

    savedWrite.resolve()
    await expect(saving).resolves.toBe('https://saved.example')
    await expect(reading).resolves.toBe('https://saved.example')
    expect(bridge.storeGet).toHaveBeenCalledExactlyOnceWith('backendBaseUrl')
  })

  it('maps a saved HTTP own-server URL to its WebSocket endpoint', async () => {
    const runtimeConfig = await initializeWithSavedUrl('http://localhost:8000', () => vi.stubEnv('VITE_WS_URL', ''))

    expect(runtimeConfig.getWSUrl()).toBe('ws://localhost:8000/ws/transcribe')
  })

  it('maps a saved HTTPS own-server path to its secure WebSocket endpoint', async () => {
    const runtimeConfig = await initializeWithSavedUrl(
      'https://custom.example:8443/path',
      () => vi.stubEnv('VITE_WS_URL', ''),
    )

    expect(runtimeConfig.getWSUrl()).toBe('wss://custom.example:8443/path/ws/transcribe')
  })

  it('gives an explicit WebSocket environment URL precedence over the saved backend', async () => {
    const runtimeConfig = await initializeWithSavedUrl(
      'http://localhost:8000',
      () => vi.stubEnv('VITE_WS_URL', 'wss://explicit.example/socket'),
    )

    expect(runtimeConfig.getWSUrl()).toBe('wss://explicit.example/socket')
  })

  it('gives a saved backend URL precedence over the backend environment URL', async () => {
    const runtimeConfig = await initializeWithSavedUrl('https://saved.example', () => {
      vi.stubEnv('VITE_BACKEND_BASE_URL', 'https://environment.example')
      vi.stubEnv('VITE_WS_URL', '')
    })

    expect(runtimeConfig.getBackendBaseUrl()).toBe('https://saved.example')
    expect(runtimeConfig.getWSUrl()).toBe('wss://saved.example/ws/transcribe')
  })

  it.each([
    {
      name: 'the backend environment URL',
      backendEnv: 'https://environment.example///',
      expectedBackend: 'https://environment.example',
      expectedWebSocket: 'wss://environment.example/ws/transcribe',
    },
    {
      name: 'the empty built-in default',
      backendEnv: '',
      expectedBackend: '',
      expectedWebSocket: '',
    },
  ])('uses $name when no backend URL is saved', async ({ backendEnv, expectedBackend, expectedWebSocket }) => {
    const runtimeConfig = await initializeWithSavedUrl(null, () => {
      vi.stubEnv('VITE_BACKEND_BASE_URL', backendEnv)
      vi.stubEnv('VITE_WS_URL', '')
    })

    expect(runtimeConfig.getBackendBaseUrl()).toBe(expectedBackend)
    expect(runtimeConfig.getWSUrl()).toBe(expectedWebSocket)
  })

  it('renders the app but skips provider initialization after runtime config initialization fails', async () => {
    vi.resetModules()
    const rootElement = {}
    const render = vi.fn()
    const createRoot = vi.fn(() => ({ render }))
    const initRuntimeConfig = vi.fn().mockRejectedValue(new Error('TLS policy initialization failed'))
    const initProviderFromStore = vi.fn()
    const App = vi.fn(() => null)
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    vi.stubGlobal('window', { addEventListener: vi.fn() })
    vi.stubGlobal('document', { getElementById: vi.fn(() => rootElement) })
    vi.doMock('../runtimeConfig', () => ({ initRuntimeConfig }))
    vi.doMock('../transcription', () => ({ initProviderFromStore }))
    vi.doMock('../debugLog', () => ({ addRuntimeEvent: vi.fn() }))
    vi.doMock('../speechInputLanguage', () => ({ initSpeechInputLanguageMigration: vi.fn().mockResolvedValue(undefined) }))
    vi.doMock('../webviewKeyboardFallback', () => ({ startWebviewKeyboardFallback: vi.fn().mockResolvedValue(undefined) }))
    vi.doMock('../../stores/language', () => ({
      initLanguage: vi.fn().mockResolvedValue('en'),
      initLocaleDefaults: vi.fn().mockResolvedValue(undefined),
    }))
    vi.doMock('../../App', () => ({ default: App }))
    vi.doMock('react-dom/client', () => ({ default: { createRoot } }))
    vi.doMock('react-router-dom', () => ({ HashRouter: ({ children }: { children: unknown }) => children }))

    await import('../../main')
    await flushBootstrap()

    expect(initProviderFromStore).not.toHaveBeenCalled()
    expect(createRoot).toHaveBeenCalledExactlyOnceWith(rootElement)
    expect(render).toHaveBeenCalledOnce()
    expect(
      (render.mock.calls[0]?.[0] as { props: { children: { props: { runtimeConfigReady: boolean } } } })
        .props.children.props.runtimeConfigReady,
    ).toBe(false)
    expect(consoleError).toHaveBeenCalledWith(
      '[bootstrap] initProviderFromStore skipped: runtime config is not ready',
    )
  })
})

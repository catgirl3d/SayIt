// @vitest-environment jsdom
import { invoke } from '@tauri-apps/api/core'
import { emit, listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanupTauriStory,
  getTauriJournal,
  installTauriBootstrap,
  tauriBeforeEach,
} from '../tauriMock'

installTauriBootstrap()

afterEach(() => {
  cleanupTauriStory()
})

describe('Tauri story harness', () => {
  it('journals and exposes an unknown command with its active story id', async () => {
    const cleanup = await tauriBeforeEach({ id: 'storybook-unknown', parameters: { tauri: {} } })

    await expect(invoke('missing-command')).rejects.toThrow(
      'Unknown Tauri command "missing-command" in story "storybook-unknown"',
    )

    cleanup()

    expect(getTauriJournal().unknownCommands).toEqual(['missing-command'])
  })

  it('treats prototype names as unknown commands', async () => {
    const cleanup = await tauriBeforeEach({ id: 'storybook-prototype', parameters: { tauri: {} } })

    await expect(invoke('constructor')).rejects.toThrow(
      'Unknown Tauri command "constructor" in story "storybook-prototype"',
    )

    cleanup()

    expect(getTauriJournal().unknownCommands).toEqual(['constructor'])
  })

  it('keeps an in-flight command bound to its original story session', async () => {
    let finishCommand: ((value: string) => void) | undefined
    const firstCleanup = await tauriBeforeEach({
      id: 'storybook-first',
      parameters: {
        tauri: {
          commands: {
            slow_command: () => new Promise<string>((resolve) => {
              finishCommand = resolve
            }),
          },
        },
      },
    })

    const result = invoke<string>('slow_command')
    firstCleanup()
    const secondCleanup = await tauriBeforeEach({ id: 'storybook-second', parameters: { tauri: {} } })
    finishCommand?.('first-result')

    await expect(result).resolves.toBe('first-result')

    secondCleanup()
  })

  it('carries late cleanup violations into the next story journal', async () => {
    const firstCleanup = await tauriBeforeEach({ id: 'storybook-first', parameters: { tauri: {} } })
    firstCleanup()

    await expect(invoke('late-cleanup-command')).rejects.toThrow(
      'Unknown Tauri command "late-cleanup-command" in story "storybook-first"',
    )

    const secondCleanup = await tauriBeforeEach({ id: 'storybook-second', parameters: { tauri: {} } })
    expect(getTauriJournal().unknownCommands).toEqual(['late-cleanup-command'])

    secondCleanup()
  })

  it('round-trips a store_set value over the seeded settings store', async () => {
    const cleanup = await tauriBeforeEach({
      id: 'storybook-store',
      parameters: { tauri: { settings: { 'demo.key': 'seeded' } } },
    })

    expect(await invoke('store_get', { key: 'demo.key' })).toBe('seeded')
    await invoke('store_set', { key: 'demo.key', value: 'updated' })

    expect(await invoke('store_get', { key: 'demo.key' })).toBe('updated')

    cleanup()
  })

  it('delivers mocked events and stops after unlisten', async () => {
    const cleanup = await tauriBeforeEach({ id: 'storybook-events', parameters: { tauri: {} } })
    const callback = vi.fn()
    const unlisten = await listen<{ value: number }>('demo-event', callback)

    await emit('demo-event', { value: 42 })
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(expect.objectContaining({
      event: 'demo-event',
      payload: { value: 42 },
    }))

    await unlisten()
    await emit('demo-event', { value: 7 })
    expect(callback).toHaveBeenCalledTimes(1)

    cleanup()
  })

  it('routes non-local fetches to the longest matching network prefix', async () => {
    let shortPrefixHit = false
    const cleanup = await tauriBeforeEach({
      id: 'storybook-network-stubs',
      parameters: {
        network: {
          'https://api.example.test/': () => {
            shortPrefixHit = true
            return new Response('short')
          },
          'https://api.example.test/v1/': (request) => {
            expect(request.method).toBe('POST')
            expect(request.headers.get('x-storybook')).toBe('network')
            return new Response(`long:${request.url}`, {
              status: 302,
              headers: { location: 'https://external.example.test/redirect-target' },
            })
          },
        },
      },
    })

    const response = await fetch(new Request('https://api.example.test/v1/status?probe=1', {
      method: 'POST',
      headers: { 'x-storybook': 'network' },
    }), {
      redirect: 'follow',
    })

    expect(response.status).toBe(302)
    expect(await response.text()).toContain('https://api.example.test/v1/status?probe=1')
    expect(shortPrefixHit).toBe(false)
    expect(getTauriJournal().stubbedRequests).toEqual(['https://api.example.test/v1/status?probe=1'])
    expect(getTauriJournal().fetchViolations).toEqual([])

    cleanup()
  })

  it('rejects and journals an unstubbed non-local fetch', async () => {
    const cleanup = await tauriBeforeEach({ id: 'storybook-network-violation', parameters: { network: {} } })

    await expect(fetch('https://unmatched.example.test/status')).rejects.toThrow(
      'Storybook fetch guard rejected non-local URL: https://unmatched.example.test/status',
    )

    expect(getTauriJournal().stubbedRequests).toEqual([])
    expect(getTauriJournal().fetchViolations).toEqual(['https://unmatched.example.test/status'])

    cleanup()
  })

  it('does not use a closed story network stub', async () => {
    const cleanup = await tauriBeforeEach({
      id: 'storybook-closed-network',
      parameters: { network: { 'https://closed.example.test/': () => new Response('should not run') } },
    })
    cleanup()

    await expect(fetch('https://closed.example.test/status')).rejects.toThrow(
      'Storybook fetch guard rejected non-local URL: https://closed.example.test/status',
    )
    expect(getTauriJournal().stubbedRequests).toEqual([])
    expect(getTauriJournal().fetchViolations).toEqual(['https://closed.example.test/status'])
  })

  it('provides idempotent main window metadata', () => {
    installTauriBootstrap()
    installTauriBootstrap()

    expect(getCurrentWindow().label).toBe('main')
  })

  it('rejects non-finite numbers as non-JSON values', async () => {
    const cleanup = await tauriBeforeEach({ id: 'storybook-numbers', parameters: { tauri: {} } })

    await expect(invoke('store_set', { key: 'infinite', value: Number.POSITIVE_INFINITY })).rejects.toThrow(
      'Tauri command "store_set" received a non-JSON value',
    )

    cleanup()

    await expect(
      tauriBeforeEach({
        id: 'storybook-bad-seed',
        parameters: { tauri: { settings: { broken: Number.NaN } } },
      }),
    ).rejects.toThrow('Story "storybook-bad-seed" seeded a non-JSON value for settings key "broken"')
  })

  it('applies store_set_app_settings atomically', async () => {
    const cleanup = await tauriBeforeEach({
      id: 'storybook-atomic',
      parameters: { tauri: { settings: { 'atomic.keep': 'original' } } },
    })

    await expect(
      invoke('store_set_app_settings', { settings: { 'atomic.ok': 1, 'atomic.bad': undefined } }),
    ).rejects.toThrow('Tauri command "store_set_app_settings" received a non-JSON value')

    expect(await invoke('store_get', { key: 'atomic.ok' })).toBe(null)
    expect(await invoke('store_get', { key: 'atomic.keep' })).toBe('original')

    cleanup()
  })

  it('saves and removes the backend address only through the dedicated commands', async () => {
    const cleanup = await tauriBeforeEach({ id: 'storybook-backend-url', parameters: { tauri: {} } })

    await invoke('store_set_backend_url', { url: 'https://custom.example' })
    expect(await invoke('store_get', { key: 'backendBaseUrl' })).toBe('https://custom.example')

    await invoke('store_delete_backend_url')
    expect(await invoke('store_get', { key: 'backendBaseUrl' })).toBe(null)

    await expect(invoke('store_set_backend_url', { url: 42 })).rejects.toThrow(
      'Tauri command "store_set_backend_url" expected string field "url"',
    )

    cleanup()
  })

  it('rejects the backend address through the generic store commands', async () => {
    const cleanup = await tauriBeforeEach({
      id: 'storybook-backend-url-guard',
      parameters: { tauri: { settings: { backendBaseUrl: 'https://seeded.example' } } },
    })

    await expect(invoke('store_set', { key: 'backendBaseUrl', value: 'https://other.example' })).rejects.toThrow(
      "'backendBaseUrl' cannot be changed through store_set; use store_set_backend_url or store_delete_backend_url",
    )
    await expect(invoke('store_delete', { key: 'backendBaseUrl' })).rejects.toThrow(
      "'backendBaseUrl' cannot be changed through store_delete",
    )
    await expect(
      invoke('store_set_app_settings', { settings: { 'other.key': 1, backendBaseUrl: 'https://other.example' } }),
    ).rejects.toThrow("'backendBaseUrl' cannot be changed through store_set_app_settings")

    expect(await invoke('store_get', { key: 'backendBaseUrl' })).toBe('https://seeded.example')
    expect(await invoke('store_get', { key: 'other.key' })).toBe(null)

    cleanup()
  })
})

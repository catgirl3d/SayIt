import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { systemAudioSession } from '@/services/systemAudio'
import Sidebar from '../Sidebar'

// The update service registers a Tauri event listener at import time; without a window
// that rejection would surface as an unhandled error while rendering the sidebar.
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => {}), emit: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

// Same server-render shim as the other page tests: the stores of the sidebar call
// useSyncExternalStore without a server snapshot, which the static renderer rejects.
vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
  }
})

function renderSidebar() {
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(Sidebar)))
}

function navEntry(markup: string, href: string) {
  const entryStart = markup.indexOf(`href="${href}"`)
  expect(entryStart, href).toBeGreaterThan(-1)
  return markup.slice(entryStart, markup.indexOf('</a>', entryStart))
}

function withSessionState<T>(state: 'listening' | 'paused', render: () => T): T {
  const spy = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue({ ...systemAudioSession.getSnapshot(), state })
  try {
    return render()
  } finally {
    spy.mockRestore()
  }
}

describe('sidebar alpha marker', () => {
  it('marks the file transcription and computer subtitles entries with the alpha badge', () => {
    const markup = renderSidebar()

    expect((markup.match(/sr-only">Alpha</g) ?? []).length).toBe(2)
    for (const href of ['/files', '/system-audio']) {
      const entryStart = markup.indexOf(`href="${href}"`)
      expect(entryStart, href).toBeGreaterThan(-1)
      const entry = markup.slice(entryStart, markup.indexOf('</a>', entryStart))
      expect(entry, href).toContain('sr-only">Alpha<')
    }
  })

  it('shows the live session state in place of the alpha badge while subtitles are listening', () => {
    const markup = withSessionState('listening', renderSidebar)

    const entry = navEntry(markup, '/system-audio')
    expect(entry).toContain('bg-success')
    expect(entry).toContain('sr-only">Listening to computer audio<')
    expect(entry).not.toContain('sr-only">Alpha<')
    expect((markup.match(/sr-only">Alpha</g) ?? []).length).toBe(1)
    expect(navEntry(markup, '/files')).toContain('sr-only">Alpha<')
  })

  it('shows the paused state in the computer subtitles entry', () => {
    const entry = navEntry(withSessionState('paused', renderSidebar), '/system-audio')

    expect(entry).toContain('bg-warning')
    expect(entry).toContain('sr-only">Subtitles paused<')
    expect(entry).not.toContain('sr-only">Alpha<')
  })
})

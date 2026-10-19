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

function renderSidebar(route = '/') {
  return renderToStaticMarkup(
    createElement(MemoryRouter, { initialEntries: [route] }, createElement(Sidebar)),
  )
}

const settingsRoutes = ['/general', '/audio', '/shortcuts', '/appearance', '/usage', '/diagnostics']

function navEntry(markup: string, href: string) {
  const entryStart = markup.indexOf(`href="${href}"`)
  expect(entryStart, href).toBeGreaterThan(-1)
  return markup.slice(entryStart, markup.indexOf('</a>', entryStart))
}

/** The opening tag of a nav entry: NavLink writes its class and aria-current before href. */
function navEntryTag(markup: string, href: string) {
  const hrefStart = markup.indexOf(`href="${href}"`)
  expect(hrefStart, href).toBeGreaterThan(-1)
  return markup.slice(markup.lastIndexOf('<a ', hrefStart), markup.indexOf('>', hrefStart) + 1)
}

function withSessionState<T>(state: 'listening' | 'paused', render: () => T): T {
  const spy = vi.spyOn(systemAudioSession, 'getSnapshot').mockReturnValue({ ...systemAudioSession.getSnapshot(), state })
  try {
    return render()
  } finally {
    spy.mockRestore()
  }
}

describe('sidebar settings group', () => {
  it('is folded by default and lists no settings pages', () => {
    const markup = renderSidebar('/history')

    expect(markup).toMatch(/aria-expanded="false"[^>]*aria-controls="sidebar-settings-items"|aria-controls="sidebar-settings-items"[^>]*aria-expanded="false"/)
    for (const href of settingsRoutes) expect(markup, href).not.toContain(`href="${href}"`)
    // The other groups are not affected.
    for (const href of ['/', '/files', '/voice-engine', '/ai-service']) expect(markup, href).toContain(`href="${href}"`)
  })

  it('opens on a settings page and marks the current entry', () => {
    const markup = renderSidebar('/audio')

    expect(markup).toContain('aria-expanded="true"')
    for (const href of settingsRoutes) expect(markup, href).toContain(`href="${href}"`)
    expect(navEntryTag(markup, '/audio')).toContain('aria-current="page"')
    expect(navEntryTag(markup, '/audio')).toContain('bg-sidebar-item-active')
    expect(navEntryTag(markup, '/shortcuts')).not.toContain('aria-current')
  })
})

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

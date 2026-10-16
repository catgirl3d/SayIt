import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
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
})

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

describe('sidebar beta marker', () => {
  it('marks only the computer subtitles entry with the beta badge', () => {
    const markup = renderSidebar()

    expect((markup.match(/Beta/g) ?? []).length).toBe(1)
    const entryStart = markup.indexOf('href="/system-audio"')
    expect(entryStart).toBeGreaterThan(-1)
    expect(markup.slice(entryStart, markup.indexOf('</a>', entryStart))).toContain('Beta')
  })
})

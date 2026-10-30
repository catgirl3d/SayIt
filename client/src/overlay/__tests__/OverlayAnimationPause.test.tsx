// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))

vi.mock('@/services/bridge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/bridge')>()
  return {
    ...actual,
    listen: (event: string, handler: (event: { payload: unknown }) => void) => {
      mocks.handlers.set(event, handler)
      return Promise.resolve(() => {})
    },
    overlayReady: () => Promise.resolve(),
    overlayRenderAck: () => Promise.resolve(),
    hideOverlay: () => Promise.resolve(),
    dismissOverlayCard: () => Promise.resolve(),
    copyText: () => Promise.resolve(),
    setEscapeActionMode: () => Promise.resolve(),
  }
})

import Overlay from '../Overlay'

const PAUSED_ATTRIBUTE = 'data-overlay-animations-paused'

function emit(name: string, payload: unknown) {
  const handler = mocks.handlers.get(name)
  if (!handler) throw new Error(`no listener registered for ${name}`)
  act(() => {
    handler({ payload })
  })
}

async function renderOverlay(): Promise<HTMLElement> {
  const { container } = render(<Overlay />)
  await waitFor(() => {
    expect(mocks.handlers.has('overlay-state')).toBe(true)
    expect(mocks.handlers.has('overlay-hidden')).toBe(true)
  })
  const root = container.firstElementChild
  if (!(root instanceof HTMLElement)) throw new Error('overlay root element is missing')
  return root
}

describe('overlay animation pause', () => {
  beforeEach(() => {
    mocks.handlers.clear()
  })

  it('starts with animations paused because the WebView is created hidden', async () => {
    const root = await renderOverlay()

    expect(root.hasAttribute(PAUSED_ATTRIBUTE)).toBe(true)
  })

  it('resumes animations on an overlay-state payload', async () => {
    const root = await renderOverlay()

    emit('overlay-state', { state: 'waiting', _overlayShowId: 3, _overlayGeneration: 0, _overlayProbe: false })

    expect(root.hasAttribute(PAUSED_ATTRIBUTE)).toBe(false)
  })

  it('pauses animations again on overlay-hidden for the shown id', async () => {
    const root = await renderOverlay()

    emit('overlay-state', { state: 'waiting', _overlayShowId: 3, _overlayGeneration: 0, _overlayProbe: false })
    emit('overlay-hidden', { showId: 3 })

    expect(root.hasAttribute(PAUSED_ATTRIBUTE)).toBe(true)
  })

  it('ignores a stale overlay-hidden from an earlier show', async () => {
    const root = await renderOverlay()

    emit('overlay-state', { state: 'waiting', _overlayShowId: 4, _overlayGeneration: 0, _overlayProbe: false })
    emit('overlay-hidden', { showId: 3 })

    expect(root.hasAttribute(PAUSED_ATTRIBUTE)).toBe(false)
  })

  it('pauses animations on overlay-hidden without a show id', async () => {
    const root = await renderOverlay()

    emit('overlay-state', { state: 'waiting', _overlayShowId: 3, _overlayGeneration: 0, _overlayProbe: false })
    emit('overlay-hidden', {})

    expect(root.hasAttribute(PAUSED_ATTRIBUTE)).toBe(true)
  })

  it('keeps animations paused for a late update of an already hidden show', async () => {
    const root = await renderOverlay()

    emit('overlay-state', { state: 'waiting', _overlayShowId: 3, _overlayGeneration: 0, _overlayProbe: false })
    emit('overlay-hidden', { showId: 3 })
    emit('overlay-state', { state: 'listening', _overlayShowId: 0, _overlayGeneration: 0, _overlayProbe: false })

    expect(root.hasAttribute(PAUSED_ATTRIBUTE)).toBe(true)
  })

  it('resumes animations for the fallback card shown at show id 0', async () => {
    const root = await renderOverlay()

    emit('overlay-state', { state: 'fallback', fallbackText: 'text', _overlayShowId: 0, _overlayGeneration: 0, _overlayProbe: false })

    expect(root.hasAttribute(PAUSED_ATTRIBUTE)).toBe(false)
  })
})

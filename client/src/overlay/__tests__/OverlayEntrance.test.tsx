// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function emitState(payload: Record<string, unknown>) {
  const handler = mocks.handlers.get('overlay-state')
  if (!handler) throw new Error('no listener registered for overlay-state')
  act(() => {
    handler({ payload })
  })
}

function emitHidden(showId: number) {
  const handler = mocks.handlers.get('overlay-hidden')
  if (!handler) throw new Error('no listener registered for overlay-hidden')
  act(() => {
    handler({ payload: { showId } })
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

const BARS = [12, 16, 9, 14, 18, 8, 11, 15, 10, 13, 17, 7, 12, 16, 9, 14, 18, 8, 11, 15, 10, 13, 17, 7]

function showId(id: number) {
  return { _overlayShowId: id, _overlayGeneration: 0, _overlayProbe: false, animationsEnabled: true }
}

function emitWaiting(id: number, extra: Record<string, unknown> = {}) {
  emitState({ state: 'waiting', ...showId(id), ...extra })
}

function emitListening(id: number, extra: Record<string, unknown> = {}) {
  emitState({
    state: 'listening',
    ...showId(id),
    bars: BARS,
    barCount: BARS.length,
    ...extra,
  })
}

// The hold and the two-frame paint gate are deterministic under fake timers; the initial render
// waits for the bridge listeners with real timers first.
async function renderWithFakeTimers(): Promise<HTMLElement> {
  const root = await renderOverlay()
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'],
  })
  return root
}

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  delete document.documentElement.dataset.motion
  vi.unstubAllGlobals()
})

describe('overlay recording entrance', () => {
  beforeEach(() => {
    mocks.handlers.clear()
  })

  it('renders nothing while the window is hidden', async () => {
    const root = await renderOverlay()
    emitListening(5)
    expect(root.querySelector('[data-overlay-content]')).not.toBeNull()

    emitHidden(5)

    expect(root.querySelector('[data-overlay-content]')).toBeNull()
    expect(root.hasAttribute('data-overlay-animations-paused')).toBe(true)
  })

  it('brings the content back with the circle entrance for the next recording', async () => {
    const root = await renderOverlay()
    emitListening(5)
    emitHidden(5)

    emitWaiting(6)

    expect(root.querySelector('[data-overlay-content]')).not.toBeNull()
    const pill = root.querySelector('.overlay-pill-recording-waiting')
    expect(pill).not.toBeNull()
    expect(pill?.classList.contains('overlay-pill-enter-circle')).toBe(true)
    const surface = root.querySelector('.overlay-pill-surface')
    expect(surface).not.toBeNull()
    expect(surface?.classList.contains('overlay-pill-surface-enter')).toBe(false)
    expect(root.hasAttribute('data-overlay-animations-paused')).toBe(false)
  })

  it('keeps the hidden window empty for a late show id 0 update', async () => {
    const root = await renderOverlay()
    emitListening(5)
    emitHidden(5)

    emitListening(0, { bars: BARS, barCount: BARS.length })
    expect(root.querySelector('[data-overlay-content]')).toBeNull()

    emitState({ state: 'fallback', ...showId(0), fallbackText: 'Recognized text' })
    expect(root.querySelector('[data-overlay-content]')?.textContent).toContain('Recognized text')
  })

  it('ignores a stale hide after the next show has started', async () => {
    const root = await renderOverlay()
    emitListening(5)
    emitHidden(4)

    expect(root.querySelector('[data-overlay-content]')).not.toBeNull()
    expect(root.hasAttribute('data-overlay-animations-paused')).toBe(false)
  })

  it('holds the circle for at least 160 ms before stretching', async () => {
    const root = await renderWithFakeTimers()
    emitWaiting(6)
    emitListening(6)

    const pill = root.querySelector<HTMLElement>('.overlay-pill-recording-waiting')
    expect(pill).not.toBeNull()
    expect(pill?.classList.contains('overlay-pill-recording-listening')).toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(159)
    })
    expect(root.querySelector('.overlay-pill-recording-listening')).toBeNull()
    expect(root.querySelector('.overlay-pill-recording-waiting')).toBe(pill)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(root.querySelector('.overlay-pill-recording-listening')).toBe(pill)
  })

  it('does not hold the circle when interface animations are off', async () => {
    const root = await renderWithFakeTimers()
    emitWaiting(6, { animationsEnabled: false })
    emitListening(6, { animationsEnabled: false })

    expect(root.querySelector('.overlay-pill-recording-waiting')).not.toBeNull()
    expect(document.documentElement.dataset.motion).toBe('off')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(32)
    })
    expect(root.querySelector('.overlay-pill-recording-listening')).not.toBeNull()
  })

  it('remounts the pill for a recording that starts inside a visible show', async () => {
    const root = await renderOverlay()
    emitState({ state: 'toast', ...showId(6), toastText: 'Text inserted', toastTone: 'info' })
    const oldPill = root.querySelector('.overlay-pill-surface')?.parentElement
    expect(oldPill).not.toBeNull()

    emitWaiting(7)

    const newPill = root.querySelector('.overlay-pill-surface')?.parentElement
    expect(newPill).not.toBe(oldPill)
    expect(newPill?.classList.contains('overlay-pill-enter-circle')).toBe(true)
  })

  it('keeps the surface-only entrance for a toast after a hidden show', async () => {
    const root = await renderOverlay()
    emitListening(5)
    emitHidden(5)

    emitState({ state: 'toast', ...showId(6), toastText: 'Text inserted', toastTone: 'info' })

    const surface = root.querySelector('.overlay-pill-surface')
    expect(surface?.classList.contains('overlay-pill-surface-enter')).toBe(true)
    expect(surface?.parentElement?.classList.contains('overlay-pill-enter-circle')).toBe(false)
  })
})

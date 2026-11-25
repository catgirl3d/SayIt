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
const LAST_FRAME = [3, 18, 6, 15, 4, 17, 5, 16, 7, 14, 8, 13, 9, 12, 10, 11, 3, 18, 6, 15, 4, 17, 5, 16]

function showId(id = 5) {
  return { _overlayShowId: id, _overlayGeneration: 0, _overlayProbe: false, animationsEnabled: true }
}

function emitListening(extra: Record<string, unknown> = {}) {
  emitState({
    state: 'listening',
    ...showId(),
    bars: BARS,
    barCount: BARS.length,
    ...extra,
  })
}

function emitThinking(id = 5) {
  emitState({ state: 'thinking', ...showId(id), elapsedSec: 10 })
}

afterEach(() => {
  delete document.documentElement.dataset.motion
  vi.unstubAllGlobals()
})

describe('overlay motion', () => {
  beforeEach(() => {
    mocks.handlers.clear()
  })

  it('collapses the last waveform frame into the processing progress bar', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()

    const collapse = root.querySelector('.overlay-wave-collapse')
    expect(collapse).not.toBeNull()
    expect(collapse?.querySelectorAll('.overlay-wave-collapse-bar')).toHaveLength(BARS.length)
    expect(collapse?.getAttribute('style')).not.toContain('--collapse-scale')

    const content = root.querySelector('.overlay-pill-content-enter')
    expect(content).not.toBeNull()
    expect(content?.getAttribute('style') ?? '').not.toContain('animation-delay')

    expect(root.querySelector('.overlay-progress-estimate')).not.toBeNull()
    expect(root.querySelector('.overlay-progress-creep')).not.toBeNull()
    expect(root.querySelector('.overlay-progress-sheen')).not.toBeNull()
  })

  it('snapshots the last listening frame, not an earlier one', async () => {
    const root = await renderOverlay()
    emitListening()
    emitState({
      state: 'listening',
      ...showId(),
      bars: LAST_FRAME,
      barCount: LAST_FRAME.length,
    })
    emitThinking()

    const bars = Array.from(root.querySelectorAll<HTMLElement>('.overlay-wave-collapse-bar'))
    expect(bars).toHaveLength(LAST_FRAME.length)
    LAST_FRAME.forEach((height, index) => {
      const clampedHeight = Math.min(18, Math.max(3, height))
      expect(bars[index].style.getPropertyValue('--from-h')).toBe(`${clampedHeight}px`)
      expect(bars[index].style.height).toBe(`${clampedHeight}px`)
      expect(Number(bars[index].style.opacity)).toBeCloseTo(0.7 + (clampedHeight / 18) * 0.3)
    })
    // The earlier frame left higher bars behind; the snapshot must not contain any of them.
    expect(bars[1].style.getPropertyValue('--from-h')).not.toBe('16px')
  })

  it('breathes recording warnings and the countdown instead of pulsing', async () => {
    const root = await renderOverlay()
    emitListening({
      warning: 'Speak closer to the microphone',
      warningTone: 'warn',
      elapsedSec: 295,
      showDuration: true,
    })

    expect(root.querySelector('.overlay-attention')?.textContent).toBe('Speak closer to the microphone')
    expect(root.querySelector('.overlay-breathe')).not.toBeNull()
    expect(root.querySelector('.animate-pulse')).toBeNull()
  })

  it('does not snapshot a muted-microphone alert', async () => {
    const root = await renderOverlay()
    emitListening({ warning: 'Microphone is muted', warningTone: 'error' })
    emitThinking()

    expect(root.querySelector('.overlay-wave-collapse')).toBeNull()
    expect(root.querySelector('.overlay-progress-estimate')).not.toBeNull()
  })

  it('keeps the pill surface and enters the toast content after processing', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()
    const surface = root.querySelector('.overlay-pill-surface')
    expect(surface).not.toBeNull()

    emitState({
      state: 'toast',
      ...showId(6),
      toastText: 'Text inserted',
      toastTone: 'info',
    })

    expect(root.querySelector('.overlay-pill-surface')).toBe(surface)
    const content = root.querySelector('.overlay-pill-content-enter')
    expect(content?.textContent).toContain('Text inserted')
  })

  it('starts a fresh surface entrance after the overlay was hidden', async () => {
    const root = await renderOverlay()
    emitListening()
    const oldSurface = root.querySelector('.overlay-pill-surface')
    expect(oldSurface).not.toBeNull()

    emitHidden(5)
    emitState({
      state: 'toast',
      ...showId(7),
      toastText: 'Text inserted',
      toastTone: 'info',
    })

    expect(root.querySelector('.overlay-pill-surface')).not.toBe(oldSurface)
    // The new show's content belongs to the fresh surface entrance, not to an in-show morph.
    expect(root.querySelector('.overlay-pill-content-enter')).toBeNull()
  })

  it('captures a fresh snapshot for a new recording after an in-show toast', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()

    const firstCollapse = root.querySelector('.overlay-wave-collapse')
    expect(firstCollapse).not.toBeNull()
    expect(firstCollapse?.querySelectorAll('.overlay-wave-collapse-bar')).toHaveLength(BARS.length)
    const surface = root.querySelector('.overlay-pill-surface')

    emitState({ state: 'toast', ...showId(6), toastText: 'Text inserted', toastTone: 'info' })
    // The toast keeps the same visible presentation, which is what used to preserve the capture gate.
    expect(root.querySelector('.overlay-pill-surface')).toBe(surface)
    expect(root.querySelector('.overlay-wave-collapse')).toBeNull()

    emitState({ state: 'waiting', ...showId(7) })
    emitListening({ ...showId(7), bars: LAST_FRAME, barCount: LAST_FRAME.length })
    await waitFor(() => {
      expect(root.querySelector('.overlay-pill-recording-listening')).not.toBeNull()
    })
    emitThinking(7)

    const bars = Array.from(root.querySelectorAll<HTMLElement>('.overlay-wave-collapse-bar'))
    expect(bars).toHaveLength(LAST_FRAME.length)
    LAST_FRAME.forEach((height, index) => {
      const clampedHeight = Math.min(18, Math.max(3, height))
      expect(bars[index].style.getPropertyValue('--from-h')).toBe(`${clampedHeight}px`)
    })
  })

  it('does not re-enter or restart content on repeated thinking updates', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()
    const content = root.querySelector('.overlay-pill-content-enter')
    const progress = root.querySelector('.overlay-progress-estimate')
    const collapse = root.querySelector('.overlay-wave-collapse')

    emitThinking()

    expect(root.querySelector('.overlay-pill-content-enter')).toBe(content)
    expect(root.querySelector('.overlay-progress-estimate')).toBe(progress)
    expect(root.querySelector('.overlay-wave-collapse')).toBe(collapse)
  })

  it('switches to a static progress bar when the animations setting is off', async () => {
    const root = await renderOverlay()
    emitListening({ animationsEnabled: false })
    emitState({ state: 'thinking', ...showId(), animationsEnabled: false, elapsedSec: 10 })

    expect(document.documentElement.dataset.motion).toBe('off')
    expect(root.querySelector('.overlay-wave-collapse')).toBeNull()
    expect(root.querySelector('.overlay-progress-estimate')).toBeNull()
    expect(root.querySelector('.overlay-progress-creep')).toBeNull()
    expect(root.querySelector('.overlay-progress-sheen')).toBeNull()
    expect(root.querySelector('.overlay-progress-static')).not.toBeNull()
  })
})

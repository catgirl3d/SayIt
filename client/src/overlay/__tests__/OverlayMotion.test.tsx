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
import { formatRecordingTimer } from '../../services/recorder/types'
import { DEFAULT_CUSTOM_WAVE, DEFAULT_WAVE_THEME, getWaveThinkingColor } from '../../lib/overlayWaveColors'

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
  return {
    _overlayShowId: id,
    _overlayGeneration: 0,
    _overlayProbe: false,
    animationsEnabled: true,
    recordingWidth: 352,
  }
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

function emitThinking(id = 5, extra: Record<string, unknown> = {}) {
  emitState({ state: 'thinking', ...showId(id), elapsedSec: 10, ...extra })
}

function pill(root: HTMLElement): HTMLElement {
  const element = root.querySelector('.overlay-pill-surface')?.parentElement
  if (!(element instanceof HTMLElement)) throw new Error('overlay pill is missing')
  return element
}

afterEach(() => {
  delete document.documentElement.dataset.motion
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('overlay motion', () => {
  beforeEach(() => {
    mocks.handlers.clear()
  })

  it('closes the last recording row into the processing circle', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()

    const frozen = root.querySelector('.overlay-wave-collapse')
    expect(frozen).not.toBeNull()
    expect(frozen?.querySelectorAll('.overlay-wave-collapse-bar')).toHaveLength(BARS.length)
    expect(pill(root).classList.contains('overlay-pill-thinking')).toBe(true)
    expect(pill(root).classList.contains('overlay-pill-recording-listening')).toBe(false)

    expect(root.querySelector('.overlay-thinking-ring-progress')).not.toBeNull()
    expect(root.querySelector('.overlay-thinking-ring')).not.toBeNull()
    expect(root.querySelector('.sr-only')?.textContent).toBe('Processing')
    // The old progress bar and its sheen are gone.
    expect(root.querySelector('.overlay-progress-estimate')).toBeNull()
    expect(root.querySelector('.overlay-progress-creep')).toBeNull()
    expect(root.querySelector('.overlay-progress-sheen')).toBeNull()
    expect(root.querySelector('.overlay-progress-static')).toBeNull()
  })

  it('freezes the last listening frame, not an earlier one', async () => {
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

  it('keeps the squeezed row, timer and warning in the live row box when processing starts', async () => {
    const liveRowWidth = 287
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const width = this.classList.contains('overlay-recording-content') ? liveRowWidth : 0
      return {
        width,
        height: 20,
        top: 0,
        left: 0,
        right: width,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
    const root = await renderOverlay()
    emitListening({
      warning: 'Speak closer to the microphone',
      warningTone: 'warn',
      elapsedSec: 295,
      showDuration: true,
    })

    const liveRow = root.querySelector<HTMLElement>('.overlay-recording-content')
    expect(liveRow).not.toBeNull()
    // Warning + countdown give up half the bars (see barBudget).
    expect(liveRow?.querySelectorAll('.overlay-recording-bars > span')).toHaveLength(12)
    const liveText = liveRow?.textContent
    expect(liveText).toContain('Speak closer to the microphone')
    expect(liveText).toContain(formatRecordingTimer(295).text)
    expect(pill(root).style.maxWidth).toBe('352px')

    emitThinking()

    const frozen = root.querySelector<HTMLElement>('.overlay-wave-collapse')
    expect(frozen).not.toBeNull()
    expect(frozen?.querySelectorAll('.overlay-wave-collapse-bar')).toHaveLength(12)
    expect(frozen?.textContent).toBe(liveText)
    expect(frozen?.style.width).toBe(`${liveRowWidth}px`)

    // Same markup as the live row, including the container that gives way under the cap.
    const liveBars = liveRow?.querySelector('.overlay-recording-bars')
    const frozenBars = frozen?.querySelector('.overlay-recording-bars')
    for (const bars of [liveBars, frozenBars]) {
      expect(bars?.classList.contains('min-w-0')).toBe(true)
      expect(bars?.classList.contains('overflow-hidden')).toBe(true)
    }
  })

  it('freezes a muted-microphone alert instead of dropping the row', async () => {
    const root = await renderOverlay()
    emitListening({ warning: 'Microphone is muted', warningTone: 'error' })
    emitThinking()

    const frozen = root.querySelector('.overlay-wave-collapse')
    expect(frozen).not.toBeNull()
    expect(frozen?.textContent).toBe('Microphone is muted')
    expect(frozen?.querySelector('.overlay-wave-collapse-bar')).toBeNull()
    expect(frozen?.querySelector<HTMLElement>('.overlay-attention')?.style.height).toBe('20px')
  })

  it('does not freeze a row for a short tap that never reached listening', async () => {
    const root = await renderOverlay()
    emitState({ state: 'waiting', ...showId() })
    emitThinking()

    expect(root.querySelector('.overlay-wave-collapse')).toBeNull()
    expect(pill(root).classList.contains('overlay-pill-thinking')).toBe(true)
    expect(root.querySelector('.overlay-thinking-ring')).not.toBeNull()
  })

  it('delays the circle fade after a visible recording and keeps the waiting glyph immediate', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()

    const fromListening = root.querySelector('.overlay-thinking-circle')
    expect(fromListening?.classList.contains('overlay-thinking-circle-from-listening')).toBe(true)
    expect(fromListening?.classList.contains('overlay-thinking-circle-from-waiting')).toBe(false)
    expect(fromListening?.querySelector('.overlay-thinking-ring-layer')).not.toBeNull()

    emitState({ state: 'waiting', ...showId(6) })
    emitThinking(6)

    const fromWaiting = root.querySelector('.overlay-thinking-circle')
    expect(fromWaiting?.classList.contains('overlay-thinking-circle-from-waiting')).toBe(true)
    expect(fromWaiting?.classList.contains('overlay-thinking-circle-from-listening')).toBe(false)
    expect(fromWaiting?.querySelector('.overlay-thinking-ring-layer')).not.toBeNull()
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

  it('grows a notice out of the processing circle without remounting the pill', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()
    const surface = root.querySelector('.overlay-pill-surface')
    const pillNode = pill(root)
    expect(surface).not.toBeNull()

    emitState({ state: 'toast', ...showId(6), toastText: 'No speech detected', toastTone: 'warn' })

    expect(root.querySelector('.overlay-pill-surface')).toBe(surface)
    expect(pill(root)).toBe(pillNode)
    expect(pill(root).classList.contains('overlay-pill-thinking')).toBe(false)
    expect(pill(root).classList.contains('overlay-pill-notice-from-circle')).toBe(true)
    expect(root.querySelector('.overlay-thinking-circle-leave')).not.toBeNull()
    const notice = root.querySelector('.overlay-notice-from-circle')
    expect(notice?.textContent).toContain('No speech detected')
    expect(root.querySelector('.overlay-pill-content-enter')?.getAttribute('style')).toContain('--pill-content-delay: 100ms')
  })

  it('keeps the AI sparkle while a notice fades out of the AI circle', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking(5, { thinkingAi: true })
    const sparkle = root.querySelector('.overlay-ai-sparkle')
    expect(sparkle).not.toBeNull()

    emitState({ state: 'toast', ...showId(6), toastText: 'No speech detected', toastTone: 'warn' })

    const ghost = root.querySelector('.overlay-thinking-circle-leave')
    expect(ghost).not.toBeNull()
    expect(ghost?.querySelector('.overlay-ai-sparkle')).toBe(sparkle)
    expect(ghost?.textContent).toBe('AI processing')
  })

  it('shows the sparkle if and only if thinkingAi is set', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()

    expect(root.querySelector('.overlay-ai-sparkle')).toBeNull()
    expect(root.querySelector('.sr-only')?.textContent).toBe('Processing')

    emitThinking(5, { thinkingAi: true })
    expect(root.querySelector('.overlay-ai-sparkle')).not.toBeNull()
    expect(root.querySelector('.sr-only')?.textContent).toBe('AI processing')

    emitThinking()
    expect(root.querySelector('.overlay-ai-sparkle')).toBeNull()
    expect(root.querySelector('.sr-only')?.textContent).toBe('Processing')
  })

  it('colors the AI sparkle with the wave thinking color', async () => {
    const root = await renderOverlay()
    emitListening()
    // The payload carries no theme, so the overlay runs on its defaults.
    emitThinking(5, { thinkingAi: true })

    const sparkle = root.querySelector('.overlay-ai-sparkle')
    const glyph = sparkle?.closest<HTMLElement>('.overlay-thinking-glyph')
    if (!glyph) throw new Error('sparkle glyph container is missing')

    // jsdom normalises inline colors to rgb(), so compare against a parsed probe.
    const probe = document.createElement('span')
    probe.style.color = getWaveThinkingColor(DEFAULT_WAVE_THEME, DEFAULT_CUSTOM_WAVE)
    expect(glyph.style.color).not.toBe('')
    expect(glyph.style.color).toBe(probe.style.color)
  })

  it('does not restart the ring on repeated thinking updates', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()
    const ring = root.querySelector('.overlay-thinking-ring')
    const circle = root.querySelector('.overlay-thinking-circle')
    const frozen = root.querySelector('.overlay-wave-collapse')

    emitThinking()
    emitThinking(5, { thinkingAi: true })
    emitThinking()

    expect(root.querySelector('.overlay-thinking-ring')).toBe(ring)
    expect(root.querySelector('.overlay-thinking-circle')).toBe(circle)
    expect(root.querySelector('.overlay-wave-collapse')).toBe(frozen)
  })

  it('drops the frozen row for a new presentation', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()
    expect(root.querySelector('.overlay-wave-collapse')).not.toBeNull()

    emitHidden(5)
    emitThinking(7)

    expect(root.querySelector('.overlay-wave-collapse')).toBeNull()
    expect(pill(root).classList.contains('overlay-pill-thinking')).toBe(true)
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
    expect(root.querySelector('.overlay-pill-notice-from-circle')).toBeNull()
  })

  it('captures a fresh frozen row for a new recording after an in-show toast', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()
    expect(root.querySelector('.overlay-wave-collapse')).not.toBeNull()

    emitState({ state: 'toast', ...showId(6), toastText: 'Text inserted', toastTone: 'info' })
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

  it('shows a static circle with interface animations off', async () => {
    const root = await renderOverlay()
    emitListening({ animationsEnabled: false })
    emitState({ state: 'thinking', ...showId(), animationsEnabled: false, elapsedSec: 10 })

    expect(document.documentElement.dataset.motion).toBe('off')
    expect(root.querySelector('.overlay-wave-collapse')).toBeNull()
    expect(pill(root).classList.contains('overlay-pill-thinking')).toBe(true)
    expect(root.querySelector('.overlay-thinking-ring-progress')).not.toBeNull()
    expect(root.querySelector('.overlay-thinking-ring')).not.toBeNull()
    expect(root.querySelector('.overlay-thinking-circle')).not.toBeNull()
    expect(root.querySelector('.overlay-ai-sparkle')).toBeNull()
    expect(root.querySelector('.overlay-progress-estimate')).toBeNull()
    expect(root.querySelector('.overlay-progress-creep')).toBeNull()
    expect(root.querySelector('.overlay-progress-sheen')).toBeNull()
    expect(root.querySelector('.overlay-progress-static')).toBeNull()
  })

  it('does not restart the ring when animations are switched back on mid-processing', async () => {
    const root = await renderOverlay()
    emitListening({ animationsEnabled: false })
    emitState({ state: 'thinking', ...showId(), animationsEnabled: false, elapsedSec: 10 })
    const ring = root.querySelector('.overlay-thinking-ring')
    expect(root.querySelector('.overlay-thinking-static')).not.toBeNull()

    emitState({ state: 'thinking', ...showId(), animationsEnabled: true, elapsedSec: 10 })

    expect(document.documentElement.dataset.motion).toBe('on')
    expect(root.querySelector('.overlay-thinking-ring')).toBe(ring)
    expect(root.querySelector('.overlay-thinking-static')).not.toBeNull()
  })

  it('does not leave the processing circle over a notice with animations off', async () => {
    const root = await renderOverlay()
    emitListening({ animationsEnabled: false })
    emitState({ state: 'thinking', ...showId(), animationsEnabled: false, elapsedSec: 10 })
    expect(root.querySelector('.overlay-thinking-circle')).not.toBeNull()

    emitState({
      state: 'toast',
      ...showId(6),
      animationsEnabled: false,
      toastText: 'No speech detected',
      toastTone: 'warn',
    })

    expect(root.querySelector('.overlay-pill-notice-from-circle')).not.toBeNull()
    expect(root.querySelector('.overlay-thinking-circle')).toBeNull()
    expect(root.querySelector('.overlay-preparing-ghost')).toBeNull()
    expect(root.querySelector('.overlay-notice-content')?.textContent).toContain('No speech detected')
  })

  it('does not leave preparing dots over a start error with animations off', async () => {
    const root = await renderOverlay()
    emitState({ state: 'waiting', ...showId(6), animationsEnabled: false })
    expect(root.querySelector('.overlay-pill-recording-waiting')).not.toBeNull()

    emitState({
      state: 'error',
      ...showId(6),
      animationsEnabled: false,
      errorMessage: 'Recording could not start',
    })

    expect(root.querySelector('.overlay-pill-notice-from-circle')).not.toBeNull()
    expect(root.querySelector('.overlay-thinking-circle')).toBeNull()
    expect(root.querySelector('.overlay-preparing-ghost')).toBeNull()
    expect(root.querySelector('.overlay-notice-content')?.textContent).toContain('Recording could not start')
  })

  it('puts the pill in the thinking exit state and clears it for a new recording', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()

    emitThinking(5, { thinkingAi: true, exit: true })
    expect(pill(root).classList.contains('overlay-pill-exit-thinking')).toBe(true)
    expect(root.querySelector('.overlay-thinking-ring')).not.toBeNull()

    emitState({ state: 'waiting', ...showId(6) })

    const nextPill = pill(root)
    expect(nextPill).not.toBeNull()
    expect(nextPill.classList.contains('overlay-pill-exit-thinking')).toBe(false)
    expect(nextPill.classList.contains('overlay-pill-recording-waiting')).toBe(true)
    expect(nextPill.classList.contains('overlay-pill-enter-circle')).toBe(true)
  })

  it('folds a notice into the circle before the exit', async () => {
    const root = await renderOverlay()
    emitListening()
    emitThinking()
    emitState({ state: 'toast', ...showId(6), toastText: 'Text inserted', toastTone: 'info' })
    const surface = root.querySelector('.overlay-pill-surface')
    const pillNode = pill(root)

    emitState({ state: 'toast', ...showId(6), exit: true })

    expect(pill(root)).toBe(pillNode)
    expect(root.querySelector('.overlay-pill-surface')).toBe(surface)
    expect(pill(root).classList.contains('overlay-pill-exit-notice')).toBe(true)
    expect(root.querySelector('.overlay-notice-content')?.textContent).toContain('Text inserted')
  })
})

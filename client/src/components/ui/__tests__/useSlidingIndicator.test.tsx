// @vitest-environment jsdom
import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useSlidingIndicator } from '../useSlidingIndicator'

const INDICATOR_TRANSITIONS: string[] = []

type Marker = 'checked' | 'pressed' | 'current'

const SELECTORS: Record<Marker, string> = {
  checked: '[aria-checked="true"]',
  pressed: '[aria-pressed="true"]',
  current: '[aria-current="page"]',
}

function markerAttributes(marker: Marker, selected: boolean) {
  switch (marker) {
    case 'pressed':
      return { 'aria-pressed': selected }
    case 'current':
      return selected ? { 'aria-current': 'page' as const } : {}
    default:
      return { 'aria-checked': selected }
  }
}

function OffsetHarness({
  active,
  animated = true,
  marker = 'checked',
  activeSelector,
}: {
  active: string
  animated?: boolean
  marker?: Marker
  activeSelector?: string
}) {
  const groupRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useSlidingIndicator(groupRef, active, { animated, activeSelector })
  return (
    <div ref={groupRef} data-testid="group" data-client-left="7" data-client-top="9" data-rect-left="500" data-rect-top="400">
      {['a', 'b'].map((key) => (
        <div
          key={key}
          data-testid={`wrapper-${key}`}
          data-parent="group"
          data-offset-left={key === 'a' ? 12 : 80}
          data-offset-top="6"
          data-client-left="2"
          data-client-top="3"
          data-w="90"
          data-h="30"
        >
          <button
            type="button"
            {...markerAttributes(marker, active === key)}
            data-testid={`button-${key}`}
            data-parent={`wrapper-${key}`}
            data-offset-left={key === 'a' ? 8 : 15}
            data-offset-top="4"
            data-w="40"
            data-h="20"
            data-rect-left={key === 'a' ? 999 : 1499}
            data-rect-top="777"
          >
            {key}
          </button>
        </div>
      ))}
      <span ref={indicatorRef} data-testid="indicator" />
    </div>
  )
}

function FallbackHarness({ active }: { active: string }) {
  const groupRef = useRef<HTMLDivElement>(null)
  const indicatorRef = useSlidingIndicator(groupRef, active)
  return (
    <div ref={groupRef} data-testid="group" data-client-left="5" data-client-top="2" data-rect-left="100" data-rect-top="50">
      {['a', 'b'].map((key) => (
        <button
          key={key}
          type="button"
          aria-checked={active === key}
          data-testid={`button-${key}`}
          data-offset-left="10"
          data-offset-top="0"
          data-w="40"
          data-h="20"
          data-rect-left={key === 'a' ? 130 : 170}
          data-rect-top="70"
        >
          {key}
        </button>
      ))}
      <span ref={indicatorRef} data-testid="indicator" />
    </div>
  )
}

function installGeometry() {
  vi.spyOn(HTMLElement.prototype, 'offsetParent', 'get').mockImplementation(function (this: HTMLElement) {
    const parentId = this.dataset.parent
    return parentId ? document.querySelector<HTMLElement>(`[data-testid="${parentId}"]`) : null
  })
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.offsetLeft ?? 0)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.offsetTop ?? 0)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid === 'indicator') INDICATOR_TRANSITIONS.push(this.style.transition)
    return Number(this.dataset.w ?? 0)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return Number(this.dataset.h ?? 0)
  })
  vi.spyOn(Element.prototype, 'clientLeft', 'get').mockImplementation(function (this: Element) {
    return Number((this as HTMLElement).dataset.clientLeft ?? 0)
  })
  vi.spyOn(Element.prototype, 'clientTop', 'get').mockImplementation(function (this: Element) {
    return Number((this as HTMLElement).dataset.clientTop ?? 0)
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const element = this as HTMLElement
    const left = Number(element.dataset.rectLeft ?? 0)
    const top = Number(element.dataset.rectTop ?? 0)
    const width = Number(element.dataset.w ?? 0)
    const height = Number(element.dataset.h ?? 0)
    return {
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      x: left,
      y: top,
      toJSON: () => ({}),
    } as DOMRect
  })
}

afterEach(() => {
  vi.restoreAllMocks()
  INDICATOR_TRANSITIONS.length = 0
})

describe('useSlidingIndicator', () => {
  it('accumulates the offset chain and ignores a deliberately scaled bounding rect', () => {
    installGeometry()
    const { getByTestId, rerender } = render(<OffsetHarness active="a" />)
    const indicator = getByTestId('indicator')

    // container -> wrapper -> button: 8 (button left) + 2 (wrapper clientLeft) + 12 (wrapper left).
    expect(indicator.style.width).toBe('40px')
    expect(indicator.style.height).toBe('20px')
    expect(indicator.style.transform).toBe('translate(22px, 13px)')
    expect(indicator.style.opacity).toBe('1')
    // The buttons' rects are deliberately wrong (999/777); the offset chain must win.
    expect(INDICATOR_TRANSITIONS[INDICATOR_TRANSITIONS.length - 1]).toBe('none')

    INDICATOR_TRANSITIONS.length = 0
    rerender(<OffsetHarness active="b" />)

    expect(indicator.style.transform).toBe('translate(97px, 13px)')
    expect(indicator.style.opacity).toBe('1')
    // Following an existing selection slides: the snapping path would read offsetWidth with the
    // transition off and record it here.
    expect(INDICATOR_TRANSITIONS).toHaveLength(0)
  })

  it('hides the indicator with no selected item and fades it back in at the offset position', () => {
    installGeometry()
    const { getByTestId, rerender } = render(<OffsetHarness active="a" />)
    const indicator = getByTestId('indicator')

    rerender(<OffsetHarness active="none" />)

    expect(indicator.style.opacity).toBe('0')

    INDICATOR_TRANSITIONS.length = 0
    rerender(<OffsetHarness active="a" />)

    expect(indicator.style.opacity).toBe('1')
    expect(indicator.style.transform).toBe('translate(22px, 13px)')
    // Coming back is a snap plus a fade, not a slide from the old geometry.
    expect(INDICATOR_TRANSITIONS).toContain('none')
  })

  it('does not animate while the caller does not allow it', () => {
    installGeometry()
    const { getByTestId, rerender } = render(<OffsetHarness active="a" animated={false} />)
    const indicator = getByTestId('indicator')

    INDICATOR_TRANSITIONS.length = 0
    rerender(<OffsetHarness active="b" animated={false} />)

    expect(indicator.style.transform).toBe('translate(97px, 13px)')
    // animated=false still takes the snap path, which reads layout while the transition is off.
    expect(INDICATOR_TRANSITIONS).toContain('none')
  })

  it('falls back to container-relative rect coordinates when the container is not on the offsetParent chain', () => {
    installGeometry()
    const { getByTestId } = render(<FallbackHarness active="a" />)
    const indicator = getByTestId('indicator')

    // rect 130/70 minus the container rect 100/50 and its 5/2 border: the offset chain never reaches the group.
    expect(indicator.style.width).toBe('40px')
    expect(indicator.style.height).toBe('20px')
    expect(indicator.style.transform).toBe('translate(25px, 18px)')
    expect(indicator.style.opacity).toBe('1')
  })

  it.each([
    { label: 'the default aria-checked selector', marker: 'checked' as const, selector: undefined },
    { label: 'an aria-pressed selector', marker: 'pressed' as const, selector: SELECTORS.pressed },
    { label: 'an aria-current selector', marker: 'current' as const, selector: SELECTORS.current },
  ])('finds the active option through $label', ({ marker, selector }) => {
    installGeometry()
    const { getByTestId } = render(<OffsetHarness active="b" marker={marker} activeSelector={selector} />)

    expect(getByTestId('indicator').style.transform).toBe('translate(97px, 13px)')
  })

  it('does not cancel an in-progress slide when an observer reports unchanged geometry', () => {
    installGeometry()
    const observers: Array<{ callback: ResizeObserverCallback; disconnects: number }> = []
    class FakeResizeObserver {
      private readonly record: { callback: ResizeObserverCallback; disconnects: number }
      constructor(callback: ResizeObserverCallback) {
        this.record = { callback, disconnects: 0 }
        observers.push(this.record)
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.record.disconnects += 1
      }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    try {
      const { getByTestId, rerender, unmount } = render(<OffsetHarness active="a" />)
      const indicator = getByTestId('indicator')
      rerender(<OffsetHarness active="b" />)
      expect(indicator.style.transform).toBe('translate(97px, 13px)')

      INDICATOR_TRANSITIONS.length = 0
      observers[observers.length - 1].callback([], {} as ResizeObserver)

      // The callback fires on observe() even when nothing changed; it must not snap and cut the
      // slide short.
      expect(INDICATOR_TRANSITIONS).toHaveLength(0)
      expect(indicator.style.transform).toBe('translate(97px, 13px)')

      getByTestId('button-b').dataset.offsetLeft = '25'
      observers[observers.length - 1].callback([], {} as ResizeObserver)

      expect(indicator.style.transform).toBe('translate(107px, 13px)')
      expect(INDICATOR_TRANSITIONS).toContain('none')

      unmount()
      expect(observers.every((observer) => observer.disconnects > 0)).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

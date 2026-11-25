// @vitest-environment jsdom
import { useRef } from 'react'
import { render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { usePillMorph } from '../pillMorph'

interface AnimationRecord {
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  cancel: ReturnType<typeof vi.fn>
  playState: AnimationPlayState
}

const animations: AnimationRecord[] = []

function installAnimationMock() {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: vi.fn((keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
      const animation: AnimationRecord = {
        keyframes,
        options,
        playState: 'running',
        cancel: vi.fn(() => { animation.playState = 'idle' }),
      }
      animations.push(animation)
      return animation as unknown as Animation
    }),
  })
}

function installWidth() {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const width = Number((this as HTMLElement).dataset.width ?? 0)
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
}

function Harness({
  morphKey,
  contentKey,
  presentationId = 1,
  width,
}: {
  morphKey: string
  contentKey?: string
  presentationId?: number
  width: number
}) {
  const ref = useRef<HTMLDivElement>(null)
  const { animateContent, enteredFrom } = usePillMorph(ref, morphKey, presentationId, contentKey)
  return (
    <div
      ref={ref}
      data-testid="pill"
      data-width={width}
      data-animate={String(animateContent)}
      data-from={enteredFrom ?? ''}
    />
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  animations.length = 0
  delete (Element.prototype as { animate?: unknown }).animate
})

describe('usePillMorph', () => {
  it('eases the width and enters new content after a key change within one show', () => {
    installAnimationMock()
    installWidth()
    const { getByTestId, rerender } = render(<Harness morphKey="recording" width={40} />)
    const pill = getByTestId('pill')

    expect(animations).toHaveLength(0)
    expect(pill.dataset.animate).toBe('false')

    rerender(<Harness morphKey="thinking" width={60} />)

    expect(animations).toHaveLength(1)
    expect(animations[0].keyframes).toEqual([{ width: '40px' }, { width: '60px' }])
    expect(String(animations[0].options.easing)).toMatch(/^cubic-bezier\(/)
    expect(pill.dataset.animate).toBe('true')
    expect(pill.dataset.from).toBe('recording')
    expect(pill.style.getPropertyValue('--pill-content-delay')).toBe('150ms')
  })

  it('keeps the content mounted when only contentKey changes', () => {
    installAnimationMock()
    installWidth()
    const { getByTestId, rerender } = render(
      <Harness morphKey="thinking" contentKey="thinking" width={48} />,
    )
    const pill = getByTestId('pill')

    rerender(<Harness morphKey="thinking" contentKey="thinking-late" width={48} />)

    expect(animations).toHaveLength(0)
    expect(pill.dataset.animate).toBe('true')
    expect(pill.dataset.from).toBe('thinking')
  })

  it('does not morph across a new show', () => {
    installAnimationMock()
    installWidth()
    const { getByTestId, rerender } = render(<Harness morphKey="recording" width={40} />)
    const pill = getByTestId('pill')

    rerender(<Harness morphKey="thinking" presentationId={2} width={60} />)

    expect(animations).toHaveLength(0)
    expect(pill.dataset.animate).toBe('false')
  })

  it('does not morph when the in-app animations switch is off', () => {
    installAnimationMock()
    installWidth()
    document.documentElement.dataset.motion = 'off'
    try {
      const { getByTestId, rerender } = render(<Harness morphKey="recording" width={40} />)

      rerender(<Harness morphKey="thinking" width={60} />)

      expect(animations).toHaveLength(0)
      expect(getByTestId('pill').dataset.animate).toBe('true')
    } finally {
      delete document.documentElement.dataset.motion
    }
  })

  it('removes the widened content delay when the next morph narrows', () => {
    installAnimationMock()
    installWidth()
    const { getByTestId, rerender } = render(<Harness morphKey="recording" width={40} />)
    const pill = getByTestId('pill')

    rerender(<Harness morphKey="thinking" width={60} />)
    expect(pill.style.getPropertyValue('--pill-content-delay')).toBe('150ms')
    // Let the widening finish; the narrowing starts from the settled 60px width.
    animations[0].playState = 'idle'

    rerender(<Harness morphKey="toast" width={40} />)
    expect(pill.style.getPropertyValue('--pill-content-delay')).toBe('')
    expect(animations).toHaveLength(2)
  })

  it('does not throw when the element cannot animate', () => {
    installWidth()
    delete (Element.prototype as { animate?: unknown }).animate
    const { getByTestId, rerender } = render(<Harness morphKey="recording" width={40} />)
    const pill = getByTestId('pill')

    rerender(<Harness morphKey="thinking" width={60} />)

    expect(animations).toHaveLength(0)
    expect(pill.dataset.animate).toBe('true')
    expect(pill.dataset.from).toBe('recording')
    expect(pill.style.getPropertyValue('--pill-content-delay')).toBe('150ms')
  })

  it('interrupts from the width currently on screen instead of the old target', () => {
    installAnimationMock()
    let measurements = [40, 40]
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => {
      const measured = measurements.shift() ?? 40
      return {
        width: measured,
        height: 20,
        top: 0,
        left: 0,
        right: measured,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect
    })
    const { rerender } = render(<Harness morphKey="recording" width={40} />)

    measurements = [60]
    rerender(<Harness morphKey="thinking" width={60} />)
    expect(animations).toHaveLength(1)
    expect(animations[0].keyframes).toEqual([{ width: '40px' }, { width: '60px' }])

    // The first read in the interrupting effect is the current on-screen width; the second is the
    // new content's natural width.
    measurements = [55, 70]
    rerender(<Harness morphKey="toast" width={70} />)

    expect(animations).toHaveLength(2)
    expect(animations[1].keyframes).toEqual([{ width: '55px' }, { width: '70px' }])
  })
})

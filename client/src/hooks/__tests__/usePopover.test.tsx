// @vitest-environment jsdom
import { useRef, useState, type RefObject } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Modal } from '@/components/ui/modal'
import { placeCard, type PlacementOptions } from '@/lib/popoverPlacement'
import { usePopover } from '../usePopover'

interface ProbeProps {
  open: boolean
  onDismiss: () => void
  name?: string
  placement?: PlacementOptions
  triggerRef?: RefObject<HTMLElement | null>
  returnFocusRef?: RefObject<HTMLElement | null>
}

function Probe({ open, onDismiss, name = 'popover', placement, triggerRef, returnFocusRef }: ProbeProps) {
  const anchorRef = useRef<HTMLButtonElement>(null)
  const { panelRef, panelStyle } = usePopover({ open, onDismiss, anchorRef, triggerRef, returnFocusRef, placement })
  return (
    <>
      <button ref={anchorRef} type="button" data-testid={`${name}-anchor`}>
        anchor
      </button>
      {open && (
        <div ref={panelRef} role="dialog" aria-label="Popover" data-testid={`${name}-panel`} style={panelStyle}>
          <span>content</span>
        </div>
      )}
    </>
  )
}

function StatefulProbe({ name, onDismiss }: { name: string; onDismiss: () => void }) {
  const [open, setOpen] = useState(true)
  return (
    <Probe
      name={name}
      open={open}
      onDismiss={() => {
        onDismiss()
        setOpen(false)
      }}
    />
  )
}

function ModalWithPopover({
  onClose,
  onDismiss,
  open = true,
}: {
  onClose: () => void
  onDismiss: () => void
  open?: boolean
}) {
  const [popoverOpen, setPopoverOpen] = useState(open)
  return (
    <Modal title="Settings" onClose={onClose}>
      <Probe
        open={popoverOpen}
        onDismiss={() => {
          onDismiss()
          setPopoverOpen(false)
        }}
      />
    </Modal>
  )
}

function FocusHost({ withReturnFocus }: { withReturnFocus: boolean }) {
  const otherRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(true)
  return (
    <>
      <button ref={otherRef} type="button" data-testid="other">
        other
      </button>
      <Probe open={open} onDismiss={() => setOpen(false)} returnFocusRef={withReturnFocus ? otherRef : undefined} />
    </>
  )
}

function SeparateTrigger({ onDismiss }: { onDismiss: () => void }) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const { panelRef, panelStyle } = usePopover({ open: true, onDismiss, anchorRef, triggerRef })
  return (
    <>
      <div ref={anchorRef} data-testid="separate-anchor">
        anchor
      </div>
      <button ref={triggerRef} type="button" data-testid="separate-trigger">
        trigger
      </button>
      <div ref={panelRef} role="dialog" data-testid="separate-panel" style={panelStyle} />
    </>
  )
}

interface Box {
  top: number
  left: number
  width: number
  height: number
}

function toRect(box: Box): DOMRect {
  return {
    x: box.left,
    y: box.top,
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  } as DOMRect
}

/** jsdom has no layout: feed the default probe anchor and panel fixed boxes and count anchor measurements. */
function mockBoxes(boxes: { anchor: Box; panel: Box }) {
  let anchorCalls = 0
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const testId = this.getAttribute('data-testid')
    if (testId === 'popover-anchor') anchorCalls += 1
    return toRect(testId === 'popover-panel' ? boxes.panel : boxes.anchor)
  })
  return { anchorCalls: () => anchorCalls }
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

const originalWidth = window.innerWidth
const originalHeight = window.innerHeight

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setViewport(originalWidth, originalHeight)
})

describe('Escape inside a Modal', () => {
  it('closes only the popover, then lets the next Escape reach the Modal', () => {
    const onClose = vi.fn()
    const onDismiss = vi.fn()
    render(<ModalWithPopover onClose={onClose} onDismiss={onDismiss} />)

    const notPrevented = fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(notPrevented).toBe(false)
    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('popover stack', () => {
  it('dismisses only the topmost popover and hands the next Escape to the one below', () => {
    const dismissA = vi.fn()
    const dismissB = vi.fn()
    render(
      <>
        <StatefulProbe name="a" onDismiss={dismissA} />
        <StatefulProbe name="b" onDismiss={dismissB} />
      </>,
    )

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(dismissB).toHaveBeenCalledTimes(1)
    expect(dismissA).not.toHaveBeenCalled()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(dismissA).toHaveBeenCalledTimes(1)
  })
})

describe('return focus', () => {
  it('focuses returnFocusRef after Escape only when it is given', () => {
    const first = render(<FocusHost withReturnFocus />)
    const other = screen.getByTestId('other')
    const anchor = screen.getByTestId('popover-anchor')
    anchor.focus()
    expect(document.activeElement).toBe(anchor)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(document.activeElement).toBe(other)
    first.unmount()

    render(<FocusHost withReturnFocus={false} />)
    const anchorWithoutReturn = screen.getByTestId('popover-anchor')
    anchorWithoutReturn.focus()

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(document.activeElement).toBe(anchorWithoutReturn)
  })
})

describe('outside mousedown', () => {
  it('dismisses outside the panel and anchor, but not on the panel or the anchor', () => {
    const onDismiss = vi.fn()
    render(<Probe open onDismiss={onDismiss} />)

    fireEvent.mouseDown(screen.getByTestId('popover-panel'))
    fireEvent.mouseDown(screen.getByTestId('popover-anchor'))
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.mouseDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('treats a separate trigger as inside even when it is outside the anchor', () => {
    const onDismiss = vi.fn()
    render(<SeparateTrigger onDismiss={onDismiss} />)

    fireEvent.mouseDown(screen.getByTestId('separate-trigger'))
    expect(onDismiss).not.toHaveBeenCalled()

    fireEvent.mouseDown(document.body)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })

  it('stops listening once the popover closes', () => {
    const onDismiss = vi.fn()
    const { rerender } = render(<Probe open onDismiss={onDismiss} />)

    rerender(<Probe open={false} onDismiss={onDismiss} />)
    fireEvent.mouseDown(document.body)

    expect(onDismiss).not.toHaveBeenCalled()
  })
})

describe('other keys', () => {
  it('leaves non-Escape keys untouched while the popover is open', () => {
    const onDismiss = vi.fn()
    render(<Probe open onDismiss={onDismiss} />)

    const notPrevented = fireEvent.keyDown(document.body, { key: 'ArrowDown' })

    expect(notPrevented).toBe(true)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('lets Escape reach the Modal unprevented while the popover is closed', () => {
    const onClose = vi.fn()
    render(
      <Modal title="Settings" onClose={onClose}>
        <Probe open={false} onDismiss={vi.fn()} />
      </Modal>,
    )

    const notPrevented = fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(notPrevented).toBe(true)
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('listener cleanup', () => {
  it('lets Escape reach the Modal after the popover closes and after it unmounts', () => {
    const onClose = vi.fn()
    const onDismiss = vi.fn()

    function Host({ showPopover, open }: { showPopover: boolean; open: boolean }) {
      return (
        <Modal title="Settings" onClose={onClose}>
          {showPopover && <Probe open={open} onDismiss={onDismiss} />}
          <span>body</span>
        </Modal>
      )
    }

    const { rerender } = render(<Host showPopover open />)

    rerender(<Host showPopover open={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(onDismiss).not.toHaveBeenCalled()

    rerender(<Host showPopover open />)
    rerender(<Host showPopover={false} open={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(2)
    expect(onDismiss).not.toHaveBeenCalled()
  })

  // A leaked keydown listener is neutralized by the stack check and cannot be seen through behavior,
  // so the add/remove pairing is asserted directly: same target, type, listener and capture flag.
  it('removes every listener it added', () => {
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const windowRemove = vi.spyOn(window, 'removeEventListener')
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const documentRemove = vi.spyOn(document, 'removeEventListener')
    const captureOf = (option: boolean | EventListenerOptions | undefined) =>
      typeof option === 'boolean' ? option : Boolean(option?.capture)

    const { unmount } = render(<Probe open onDismiss={vi.fn()} />)
    unmount()

    const targets = [
      { name: 'window', add: windowAdd, remove: windowRemove },
      { name: 'document', add: documentAdd, remove: documentRemove },
    ]
    for (const type of ['keydown', 'mousedown', 'resize', 'scroll']) {
      let observed = 0
      for (const { name, add, remove } of targets) {
        const added = add.mock.calls.filter(([addedType]) => addedType === type)
        observed += added.length
        for (const [, listener, option] of added) {
          const removed = remove.mock.calls.some(
            ([removedType, removedListener, removedOption]) =>
              removedType === type && removedListener === listener && captureOf(removedOption) === captureOf(option),
          )
          expect(removed, `${type} listener added on ${name} is removed`).toBe(true)
        }
      }
      expect(observed, `${type} listener was added`).toBeGreaterThan(0)
    }
  })
})

describe('positioning', () => {
  it('keeps the panel hidden until a measurement is possible', () => {
    function Unanchored() {
      const anchorRef = useRef<HTMLDivElement>(null)
      const { panelRef, panelStyle } = usePopover({ open: true, onDismiss: () => {}, anchorRef })
      return <div ref={panelRef} role="dialog" data-testid="unanchored-panel" style={panelStyle} />
    }

    render(<Unanchored />)

    const panel = screen.getByTestId('unanchored-panel')
    expect(panel.style.top).toBe('-9999px')
    expect(panel.style.left).toBe('-9999px')
  })

  it('places the measured panel with placeCard', () => {
    setViewport(800, 600)
    mockBoxes({
      anchor: { top: 100, left: 40, width: 24, height: 36 },
      panel: { top: 0, left: 0, width: 224, height: 250 },
    })
    render(<Probe open onDismiss={vi.fn()} />)

    const panel = screen.getByTestId('popover-panel')
    const placed = placeCard(
      { top: 100, bottom: 136, left: 40, width: 24 },
      { width: 224, height: 250 },
      { width: 800, height: 600 },
    )
    expect({ top: Number.parseFloat(panel.style.top), left: Number.parseFloat(panel.style.left) }).toEqual(placed)
  })

  it('re-measures on resize and on scroll outside the panel, but not on scroll inside it', () => {
    setViewport(800, 600)
    const boxes = {
      anchor: { top: 100, left: 40, width: 24, height: 36 },
      panel: { top: 0, left: 0, width: 224, height: 250 },
    }
    const counter = mockBoxes(boxes)
    render(<Probe open onDismiss={vi.fn()} />)

    const panel = screen.getByTestId('popover-panel')
    expect(counter.anchorCalls()).toBe(1)
    expect(panel.style.top).toBe('144px')

    boxes.anchor = { top: 200, left: 40, width: 24, height: 36 }
    fireEvent.resize(window)
    expect(counter.anchorCalls()).toBe(2)
    expect(panel.style.top).toBe('244px')

    boxes.anchor = { top: 290, left: 40, width: 24, height: 36 }
    fireEvent.scroll(document.body)
    expect(counter.anchorCalls()).toBe(3)
    expect(panel.style.top).toBe('334px')

    boxes.anchor = { top: 400, left: 40, width: 24, height: 36 }
    fireEvent.scroll(panel)
    expect(counter.anchorCalls()).toBe(3)
    expect(panel.style.top).toBe('334px')
  })
})

describe('ResizeObserver', () => {
  it('re-measures when the panel size changes', () => {
    setViewport(800, 600)
    const boxes = {
      anchor: { top: 100, left: 40, width: 24, height: 36 },
      panel: { top: 0, left: 0, width: 224, height: 250 },
    }
    mockBoxes(boxes)

    const callbacks: ResizeObserverCallback[] = []
    const observed: Element[] = []
    class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callbacks.push(callback)
      }
      observe = (element: Element) => {
        observed.push(element)
      }
      unobserve = () => {}
      disconnect = () => {}
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)

    render(<Probe open onDismiss={vi.fn()} />)

    const panel = screen.getByTestId('popover-panel')
    expect(callbacks).toHaveLength(1)
    expect(observed).toEqual([panel])
    expect(panel.style.top).toBe('144px')

    boxes.panel = { top: 0, left: 0, width: 224, height: 500 }
    act(() => callbacks[0]([], {} as ResizeObserver))

    expect(panel.style.top).toBe('8px')
  })
})

describe('latest onDismiss', () => {
  it('does not resubscribe the key listener when onDismiss changes and calls the latest one', () => {
    const add = vi.spyOn(window, 'addEventListener')
    const first = vi.fn()
    const second = vi.fn()
    const third = vi.fn()

    const { rerender } = render(<Probe open onDismiss={first} />)
    rerender(<Probe open onDismiss={second} />)
    rerender(<Probe open onDismiss={third} />)

    const keydownAdds = add.mock.calls.filter(([type]) => type === 'keydown')
    expect(keydownAdds).toHaveLength(1)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(third).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    expect(second).not.toHaveBeenCalled()
  })
})

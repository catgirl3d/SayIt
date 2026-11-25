// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Select } from '../select'

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
  { value: 'gamma', label: 'Gamma' },
]

function setViewportHeight(height: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

/** jsdom has no layout: the trigger gets a fixed 300x36 box at `top`, everything else measures zero. */
function mockTriggerBox(top: number) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.matches('button[aria-expanded]')) {
      return {
        x: 40,
        y: top,
        top,
        bottom: top + 36,
        left: 40,
        right: 340,
        width: 300,
        height: 36,
        toJSON: () => ({}),
      } as DOMRect
    }
    return { x: 0, y: 0, top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, toJSON: () => ({}) } as DOMRect
  })
}

function openSelect() {
  render(<Select value="" onChange={() => undefined} options={options} />)
  const trigger = document.querySelector('button[aria-expanded]') as HTMLButtonElement
  fireEvent.click(trigger)
  const option = screen.getByRole('button', { name: 'Alpha' })
  const list = option.parentElement as HTMLElement
  const panel = list.parentElement as HTMLElement
  return { trigger, option, list, panel }
}

describe('Select list placement', () => {
  const originalHeight = window.innerHeight

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    setViewportHeight(originalHeight)
  })

  it('opens below the trigger when there is room', () => {
    setViewportHeight(800)
    mockTriggerBox(100)
    const { panel, list } = openSelect()

    // Below 800 - 136 - 8 = 656, enough for the 240px cap.
    expect(panel.style.top).toBe('140px')
    expect(panel.style.bottom).toBe('')
    expect(panel.style.left).toBe('40px')
    expect(panel.style.width).toBe('300px')
    expect(panel.style.maxHeight).toBe('240px')
    expect(list.style.maxHeight).toBe('238px')
  })

  it('opens above and pins the list to the trigger by its bottom edge', () => {
    setViewportHeight(800)
    mockTriggerBox(700)
    const { panel } = openSelect()

    // Below 56 < 180 and above is 692, so it opens upward; 800 - 700 + 4 = 104px from the bottom.
    expect(panel.style.bottom).toBe('104px')
    expect(panel.style.top).toBe('')
    expect(panel.style.maxHeight).toBe('240px')
  })

  it('stays below exactly at the preferred threshold', () => {
    setViewportHeight(800)
    mockTriggerBox(520)
    const { panel } = openSelect()

    // Below 800 - 556 - 8 = 236 is still >= 180, so it stays below with that cap.
    expect(panel.style.top).toBe('560px')
    expect(panel.style.maxHeight).toBe('236px')
  })

  it('opens above just under the preferred threshold', () => {
    setViewportHeight(800)
    mockTriggerBox(600)
    const { panel } = openSelect()

    // Below 156 < 180 and above is 592, so it opens upward.
    expect(panel.style.bottom).toBe('204px')
    expect(panel.style.maxHeight).toBe('240px')
  })

  it('keeps the minimum list height when neither side has room', () => {
    setViewportHeight(200)
    mockTriggerBox(60)
    const { panel } = openSelect()

    // Below 96, above 52: the larger side wins, and the floor keeps the list at 120px.
    expect(panel.style.top).toBe('100px')
    expect(panel.style.maxHeight).toBe('120px')
  })

  it('does not treat the trigger as outside: a mousedown keeps the list, a click toggles it shut', () => {
    setViewportHeight(800)
    mockTriggerBox(100)
    const { trigger } = openSelect()

    fireEvent.mouseDown(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(trigger)
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull()
  })

  it('does not close on a mousedown inside the list', () => {
    setViewportHeight(800)
    mockTriggerBox(100)
    const { trigger, option } = openSelect()

    fireEvent.mouseDown(option)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy()
  })
})

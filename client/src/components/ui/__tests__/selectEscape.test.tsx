// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from '../modal'
import { Select } from '../select'

const options = [
  { value: 'alpha', label: 'Alpha' },
  { value: 'beta', label: 'Beta' },
]

function getTrigger(): HTMLButtonElement {
  return document.querySelector('button[aria-expanded]') as HTMLButtonElement
}

function renderInDialog() {
  const onClose = vi.fn()
  render(
    <Modal title="Edit provider" onClose={onClose}>
      <Select value="" onChange={() => undefined} options={options} />
    </Modal>,
  )
  return { onClose, trigger: getTrigger() }
}

function renderPlain() {
  render(
    <div>
      <Select value="" onChange={() => undefined} options={options} />
    </div>,
  )
  return { trigger: getTrigger() }
}

function openList(trigger: HTMLButtonElement): HTMLButtonElement {
  fireEvent.click(trigger)
  expect(trigger.getAttribute('aria-expanded')).toBe('true')
  return screen.getByRole('button', { name: 'Alpha' })
}

describe('Select Escape inside a dialog', () => {
  it('closes only the list first, then lets the next Escape close the dialog', () => {
    const { onClose, trigger } = renderInDialog()
    openList(trigger)

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

    expect(within(document.body).queryByRole('button', { name: 'Alpha' })).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(onClose).not.toHaveBeenCalled()

    // The window listener lives only while the list is open: this Escape reaches the dialog.
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('returns focus to the trigger even when an option in the portal had focus', () => {
    const { trigger } = renderInDialog()
    const option = openList(trigger)

    option.focus()
    expect(document.activeElement).toBe(option)
    expect(document.activeElement).not.toBe(trigger)

    fireEvent.keyDown(option, { key: 'Escape' })

    expect(document.activeElement).toBe(trigger)
  })

  it('closes the list and focuses the trigger without a surrounding dialog', () => {
    const { trigger } = renderPlain()
    const option = openList(trigger)

    option.focus()
    expect(document.activeElement).toBe(option)

    fireEvent.keyDown(option, { key: 'Escape' })

    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it('leaves Escape alone while the list is closed', () => {
    const { onClose, trigger } = renderInDialog()

    const notPrevented = fireEvent.keyDown(trigger, { key: 'Escape' })

    expect(onClose).toHaveBeenCalledTimes(1)
    expect(notPrevented).toBe(true)
  })

  it('lets other keys through while the list is open', () => {
    const { onClose, trigger } = renderInDialog()
    openList(trigger)

    const notPrevented = fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })

    expect(notPrevented).toBe(true)
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeTruthy()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes the list on a mousedown outside', () => {
    const { trigger } = renderInDialog()
    openList(trigger)

    fireEvent.mouseDown(document.body)

    expect(within(document.body).queryByRole('button', { name: 'Alpha' })).toBeNull()
  })
})

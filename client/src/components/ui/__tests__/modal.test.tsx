// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { Modal } from '../modal'

function renderModal(onClose = vi.fn()) {
  render(
    <Modal title="Edit provider" onClose={onClose}>
      <input aria-label="API key" />
    </Modal>,
  )
  // The backdrop is the dialog's parent: the fixed full-screen layer that closes on click.
  const backdrop = screen.getByRole('dialog').parentElement as HTMLElement
  return { onClose, backdrop }
}

describe('Modal backdrop', () => {
  it('closes when the press starts and ends on the backdrop', () => {
    const { onClose, backdrop } = renderModal()

    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open when a press starts inside the panel and is released over the backdrop', () => {
    const { onClose, backdrop } = renderModal()

    // Selecting text in an input and releasing the button outside the panel makes the browser
    // dispatch `click` on the nearest common ancestor, which is the backdrop.
    fireEvent.mouseDown(screen.getByLabelText('API key'))
    fireEvent.click(backdrop)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on a backdrop press after an earlier press inside the panel', () => {
    const { onClose, backdrop } = renderModal()

    fireEvent.mouseDown(screen.getByLabelText('API key'))
    fireEvent.click(backdrop)
    fireEvent.mouseDown(backdrop)
    fireEvent.click(backdrop)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close on a click inside the panel', () => {
    const { onClose } = renderModal()

    fireEvent.mouseDown(screen.getByLabelText('API key'))
    fireEvent.click(screen.getByLabelText('API key'))

    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('Modal stack', () => {
  function Stack({ bottomClose, topClose, showTop }: { bottomClose: () => void; topClose: () => void; showTop: boolean }) {
    return (
      <>
        <Modal title="Backups" onClose={bottomClose}>list</Modal>
        {showTop && <Modal title="Confirm restore" onClose={topClose}>confirm</Modal>}
      </>
    )
  }

  it('closes only the topmost modal on Esc', () => {
    const bottomClose = vi.fn()
    const topClose = vi.fn()
    render(<Stack bottomClose={bottomClose} topClose={topClose} showTop />)

    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(topClose).toHaveBeenCalledTimes(1)
    expect(bottomClose).not.toHaveBeenCalled()
  })

  it('hands Esc back to the modal underneath once the top one is gone', () => {
    const bottomClose = vi.fn()
    const topClose = vi.fn()
    const { rerender } = render(<Stack bottomClose={bottomClose} topClose={topClose} showTop />)

    rerender(<Stack bottomClose={bottomClose} topClose={topClose} showTop={false} />)
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(bottomClose).toHaveBeenCalledTimes(1)
    expect(topClose).not.toHaveBeenCalled()
  })
})

describe('Modal layout', () => {
  it('reserves room for the close button next to the title', () => {
    render(<Modal title="With close" onClose={vi.fn()} showCloseButton>body</Modal>)

    expect(screen.getByText('With close').className).toContain('pr-6')
  })

  it('does not pad the title when there is no close button', () => {
    render(<Modal title="Without close" onClose={vi.fn()}>body</Modal>)

    expect(screen.getByText('Without close').className).not.toContain('pr-6')
  })
})

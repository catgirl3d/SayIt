// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { FullImportConfirmDialog, ImportDoneDialog } from '../ConfigTransferDialogs'

function renderConfirm() {
  const props = {
    filePath: 'C:\\backups\\sayit-full.zip',
    onClose: vi.fn(),
    onConfirm: vi.fn(),
  }
  return { props, ...render(<FullImportConfirmDialog {...props} />) }
}

describe('FullImportConfirmDialog', () => {
  it('renders as a dialog named by its title and described by its description', () => {
    renderConfirm()

    const dialog = screen.getByRole('dialog', { name: t('configTransfer.fullDataTitle') })
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy as string)?.textContent).toBe(t('configTransfer.fullDataDesc'))
    expect(screen.getByText('sayit-full.zip')).toBeTruthy()
  })

  it('calls onClose from Cancel, the close button and Esc', () => {
    const { props } = renderConfirm()

    fireEvent.click(screen.getByRole('button', { name: t('configTransfer.cancel') }))
    fireEvent.click(screen.getByRole('button', { name: t('window.close') }))
    fireEvent.keyDown(document.body, { key: 'Escape' })

    expect(props.onClose).toHaveBeenCalledTimes(3)
    expect(props.onConfirm).not.toHaveBeenCalled()
  })

  it('calls onConfirm only from the overwrite button', () => {
    const { props } = renderConfirm()

    fireEvent.click(screen.getByRole('button', { name: t('configTransfer.overwriteImport') }))

    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('keeps the dialog open when a press starts inside it and ends on the backdrop', () => {
    const { props } = renderConfirm()
    const backdrop = screen.getByRole('dialog').parentElement as HTMLElement

    fireEvent.mouseDown(screen.getByText('sayit-full.zip'))
    fireEvent.click(backdrop)

    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog on open', () => {
    renderConfirm()

    expect(screen.getByRole('dialog').contains(document.activeElement)).toBe(true)
  })
})

describe('ImportDoneDialog', () => {
  it('is an alert dialog named by the result and described by the restart notice', () => {
    render(<ImportDoneDialog />)

    const dialog = screen.getByRole('alertdialog', { name: t('configTransfer.importDone') })
    const describedBy = dialog.getAttribute('aria-describedby')
    expect(document.getElementById(describedBy as string)?.textContent).toBe(t('configTransfer.restarting'))
  })

  it('takes focus itself because it has no controls', () => {
    render(<ImportDoneDialog />)

    expect(document.activeElement).toBe(screen.getByRole('alertdialog'))
  })
})

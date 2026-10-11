// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { ConfirmDeleteModal } from '../ConfirmDeleteModal'

function renderModal(overrides: Partial<Parameters<typeof ConfirmDeleteModal>[0]> = {}) {
  const props = {
    title: 'Delete profile',
    body: <span>Delete “DeepSeek Chat”?</span>,
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  }
  return { props, ...render(<ConfirmDeleteModal {...props} />) }
}

describe('ConfirmDeleteModal', () => {
  it('renders the dialog title and body', () => {
    renderModal()

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Delete profile')).toBeTruthy()
    expect(screen.getByText('Delete “DeepSeek Chat”?')).toBeTruthy()
  })

  it('calls onCancel and onConfirm from the footer buttons', () => {
    const { props } = renderModal()

    fireEvent.click(screen.getByRole('button', { name: t('common.cancel') }))
    fireEvent.click(screen.getByRole('button', { name: t('common.delete') }))

    expect(props.onCancel).toHaveBeenCalledTimes(1)
    expect(props.onConfirm).toHaveBeenCalledTimes(1)
  })

  it('keeps the confirm action wired in the danger variant', () => {
    const { props } = renderModal({ danger: true })

    fireEvent.click(screen.getByRole('button', { name: t('common.delete') }))

    expect(props.onConfirm).toHaveBeenCalledTimes(1)
    expect(props.onCancel).not.toHaveBeenCalled()
  })

  it('shows the close button only when requested', () => {
    const { unmount } = renderModal()
    expect(screen.queryByLabelText(t('window.close'))).toBeNull()
    unmount()

    const onCancel = vi.fn()
    renderModal({ onCancel, showCloseButton: true })
    fireEvent.click(screen.getByLabelText(t('window.close')))

    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})

// Shared confirmation dialog for the profile lists and other interruptible actions. Both settings sections
// used to inline the same shell (Modal at a fixed width, Cancel + Delete footer at
// the same spots); the only real differences were the body sentence and the confirm
// button styling and label, which are parameters here.

import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { useT } from '@/i18n/useT'

interface ConfirmDeleteModalProps {
  title: string
  body: ReactNode
  onCancel: () => void
  onConfirm: () => void
  showCloseButton?: boolean
  /** Renders the confirm action with the destructive outline styling (AI section). */
  danger?: boolean
  confirmLabel?: string
}

export function ConfirmDeleteModal({
  title,
  body,
  onCancel,
  onConfirm,
  showCloseButton,
  danger,
  confirmLabel,
}: ConfirmDeleteModalProps) {
  const t = useT()
  const actionLabel = confirmLabel ?? t('common.delete')
  return (
    <Modal title={title} onClose={onCancel} showCloseButton={showCloseButton} panelClassName="w-[420px]">
      <div className="mt-3 space-y-4">
        <div className="text-sm leading-relaxed text-muted-foreground">{body}</div>
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" className="h-9" onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          {danger ? (
            <button
              type="button"
              onClick={onConfirm}
              className="h-9 rounded-md border border-destructive/30 bg-destructive/5 px-3 text-sm font-medium text-destructive-strong transition-colors hover:bg-destructive/10"
            >
              {actionLabel}
            </button>
          ) : (
            <Button size="sm" className="h-9" onClick={onConfirm}>
              {actionLabel}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  )
}

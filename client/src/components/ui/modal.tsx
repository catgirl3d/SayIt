// Modal shell: Esc to close, focus trap, focus restored on close, role="dialog"
//
// Why this exists: the settings page had three hand-rolled dialogs (offline download guide /
// confirm model deletion / change model directory), each one a `fixed inset-0 + <div onClick>`
// backdrop with no role, no aria-modal, no reaction to Esc, focus left on the page behind after
// opening, and Tab able to escape the dialog. The delete-confirmation dialog was the worst case:
// the only keyboard way to close it was to Tab to "Cancel" (a backdrop click needs a mouse).
// The semantics are fixed here, once.

import { useCallback, useEffect, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useT } from '@/i18n/useT'
import { cn } from '@/lib/utils'

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Open modals, bottom to top. Only the topmost one answers to Esc and Tab. Every modal listens on
// `document`, and stopPropagation does not keep a second listener on the same node from running,
// so with two stacked dialogs (a list and a confirmation over it) a single Esc would close both.
const openModals: symbol[] = []

export interface ModalProps {
  /** Dialog title, also used as the accessible name */
  title: string
  onClose: () => void
  /** While locked (e.g. during a file migration), disables Esc and backdrop clicks so a dangerous operation is not interrupted */
  locked?: boolean
  /** Whether to show the close button in the top-right corner. Confirmation dialogs use bottom buttons and do not need it */
  showCloseButton?: boolean
  /** Panel width class, e.g. 'w-[520px]'. max-w-[calc(100vw-2rem)] is always applied so small windows do not overflow */
  panelClassName?: string
  children: ReactNode
}

export function Modal({
  title,
  onClose,
  locked,
  showCloseButton,
  panelClassName,
  children,
}: ModalProps) {
  const t = useT()
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useRef(`modal-title-${Math.random().toString(36).slice(2, 8)}`).current
  const stackToken = useRef(Symbol('modal')).current

  const requestClose = useCallback(() => {
    if (!locked) onClose()
  }, [locked, onClose])

  // Whether the latest mouse press began inside the panel. Selecting text in an input and releasing
  // the button outside the panel makes the browser dispatch `click` on the nearest common ancestor
  // of the press and release targets, which is the backdrop; without this guard that drag closes
  // the dialog and throws away whatever was typed.
  const pressStartedInPanel = useRef(false)

  /**
   * On open, moves focus into the dialog (otherwise screen-reader and keyboard users stay on the
   * page behind it); on close, returns it.
   *
   * Must have empty deps and run only once: this used to share an effect with the key listener
   * below and depend on requestClose, and requestClose changes with the onClose passed in by the
   * caller. Unless the caller's onClose is wrapped in useCallback (the normal way to write it is
   * not), every re-render produces a new function -> the effect reruns -> focus is pulled back to
   * the first control. Symptom: "every character typed into an input sends the cursor back to the
   * dropdown above".
   *
   * To choose which control receives focus, add data-modal-autofocus to it (or to its container).
   */
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    const preferred = panel?.querySelector<HTMLElement>('[data-modal-autofocus]')
    const target = preferred?.matches(FOCUSABLE)
      ? preferred
      : preferred?.querySelector<HTMLElement>(FOCUSABLE)
      ?? panel?.querySelector<HTMLElement>(FOCUSABLE)
      ; (target ?? panel)?.focus()

    return () => { previouslyFocused?.focus?.() }
  }, [])

  useEffect(() => {
    openModals.push(stackToken)
    return () => {
      const index = openModals.indexOf(stackToken)
      if (index !== -1) openModals.splice(index, 1)
    }
  }, [stackToken])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (openModals[openModals.length - 1] !== stackToken) return
      if (event.key === 'Escape') {
        event.stopPropagation()
        requestClose()
        return
      }
      if (event.key !== 'Tab') return

      // Focus trap: when Tab reaches either end, wrap around inside the dialog instead of escaping to the page behind
      const focusables = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      if (focusables.length === 0) return
      const firstEl = focusables[0]
      const lastEl = focusables[focusables.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === firstEl || active === panelRef.current)) {
        event.preventDefault()
        lastEl.focus()
      } else if (!event.shiftKey && active === lastEl) {
        event.preventDefault()
        firstEl.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [requestClose, stackToken])

  const closeButton = (className: string) => (
    <button
      type="button"
      onClick={requestClose}
      aria-label={t('window.close')}
      className={cn('rounded-md p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground', className)}
    >
      <X className="h-4 w-4" aria-hidden />
    </button>
  )

  return createPortal(
    <div
      // The backdrop uses fixed black rather than --foreground: in the dark theme foreground is a
      // near-white light gray, and using it as the backdrop would light the background up. The
      // backdrop must be dark in every theme.
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => { pressStartedInPanel.current = e.target !== e.currentTarget }}
      onClick={() => { if (!pressStartedInPanel.current) requestClose() }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'relative max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-card p-6 shadow-xl',
          panelClassName,
        )}
      >
        {showCloseButton && closeButton('absolute right-3 top-3')}
        {/* pr-6 keeps a long title from running under the absolutely positioned close button */}
        <h3 id={titleId} className={cn('text-base font-semibold', showCloseButton && 'pr-6')}>{title}</h3>
        {children}
      </div>
    </div>,
    document.body,
  )
}

// Page-level help: a "Help" text button for the page header that opens a short
// help dialog. Shared by the Voice engine and AI providers pages; each page passes
// its own dialog title and body, and all copy lives in the locale files.

import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Modal } from '@/components/ui/modal'
import { useT } from '@/i18n/useT'

interface PageHelpProps {
  title: string
  children: ReactNode
}

export function PageHelp({ title, children }: PageHelpProps) {
  const t = useT()
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
        {t('help.button')}
      </Button>
      {open && (
        // The shared Modal panel scrolls with the browser's default scrollbar unless the
        // app's custom-scrollbar class is passed; every other scroll area uses it.
        <Modal title={title} onClose={() => setOpen(false)} showCloseButton panelClassName="custom-scrollbar w-[520px]">
          <div className="mt-3 space-y-5">{children}</div>
        </Modal>
      )}
    </>
  )
}

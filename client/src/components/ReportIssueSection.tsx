import { useState } from 'react'
import { Bug } from 'lucide-react'
import { open } from '@tauri-apps/plugin-shell'
import { PROJECT_BUG_REPORT_URL } from '@/services/projectLinks'
import { t, type TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

export default function ReportIssueSection() {
  useT()

  const [openFailed, setOpenFailed] = useState(false)
  const text = (key: string) => t(key as TranslationKey)

  const handleOpenIssue = async () => {
    setOpenFailed(false)
    try {
      await open(PROJECT_BUG_REPORT_URL)
    } catch {
      setOpenFailed(true)
    }
  }

  return (
    <div>
      <h2 className="mb-3 text-lg font-semibold">{text('reportIssue.title')}</h2>

      <div className="rounded-xl border border-border p-4">
        <p className="text-sm text-muted-foreground">{text('reportIssue.description')}</p>
        <p className="mt-2 text-xs leading-relaxed text-muted-foreground/70">{text('reportIssue.publicNotice')}</p>
        {openFailed && <p className="mt-3 text-xs text-destructive">{text('reportIssue.openFailed')}</p>}
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={() => void handleOpenIssue()}
            className="flex items-center gap-1.5 rounded-full bg-secondary px-4 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-foreground hover:text-background"
          >
            <Bug className="h-3.5 w-3.5" aria-hidden />
            {text('reportIssue.open')}
          </button>
        </div>
      </div>
    </div>
  )
}

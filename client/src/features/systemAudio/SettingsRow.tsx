import { Button } from '@/components/ui/button'
import { useT } from '@/i18n/useT'

interface SettingsRowProps {
  title: string
  /** One-line current state; empty while the saved values are still loading. */
  summary: string
  /** Accessible name of the button: every row shows the same visible "Configure" label. */
  configureLabel: string
  onConfigure: () => void
}

// The "Configure" button carries its own accessible name: both rows show the same visible label, so
// without it a screen reader hears two identical buttons.
export default function SettingsRow({ title, summary, configureLabel, onConfigure }: SettingsRowProps) {
  const t = useT()
  return (
    <div className="flex items-center justify-between gap-4 px-6 py-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="min-h-[1rem] truncate text-xs text-muted-foreground" title={summary}>{summary}</p>
      </div>
      <Button variant="outline" size="sm" className="shrink-0" aria-label={configureLabel} onClick={onConfigure}>{t('systemAudio.configure')}</Button>
    </div>
  )
}

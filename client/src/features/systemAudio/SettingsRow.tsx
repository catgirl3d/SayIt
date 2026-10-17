import { useId } from 'react'
import { ChevronRight, Lock, type LucideIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface SettingsRowProps {
  icon: LucideIcon
  title: string
  /** One-line current state; empty while the saved values are still loading. */
  summary: string
  /** Accessible name of the row's button: the action it performs, e.g. "Configure captions". */
  configureLabel: string
  /** A subtitle session is running: the row shows a lock instead of a chevron. It stays clickable so its dialog opens with the controls disabled. */
  locked?: boolean
  onConfigure: () => void
}

// The whole row is the Configure button. Its accessible name is configureLabel because that names the
// action the row performs; the summary is attached as its description, so the current state is read
// after the name instead of replacing it.
export default function SettingsRow({ icon: Icon, title, summary, configureLabel, locked = false, onConfigure }: SettingsRowProps) {
  const summaryId = useId()
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={configureLabel}
      aria-describedby={summary ? summaryId : undefined}
      onClick={onConfigure}
      className="h-auto w-full justify-start gap-4 rounded-none px-6 py-3.5 text-left font-normal"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span id={summaryId} className="block min-h-[1rem] truncate text-xs text-muted-foreground" title={summary}>{summary}</span>
      </span>
      {locked
        ? <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
        : <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
    </Button>
  )
}

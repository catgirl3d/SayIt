import { useCallback, useState } from 'react'
import { Cloud, Cpu, Loader2, type LucideIcon } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { useT } from '@/i18n/useT'

export type MigrationWorkMode = 'local' | 'cloud_api'

interface Props {
  onChoose: (mode: MigrationWorkMode) => Promise<void>
}

const options: Array<{
  mode: MigrationWorkMode
  icon: LucideIcon
  titleKey: 'workModeMigration.local' | 'workModeMigration.cloudApi'
  hintKey: 'workModeMigration.localHint' | 'workModeMigration.cloudApiHint'
}> = [
  { mode: 'local', icon: Cpu, titleKey: 'workModeMigration.local', hintKey: 'workModeMigration.localHint' },
  { mode: 'cloud_api', icon: Cloud, titleKey: 'workModeMigration.cloudApi', hintKey: 'workModeMigration.cloudApiHint' },
]

export default function WorkModeMigrationDialog({ onChoose }: Props) {
  const t = useT()
  const [pending, setPending] = useState<MigrationWorkMode | null>(null)
  const [error, setError] = useState('')
  // The dialog is deliberately not dismissible: without a mode choice dictation stays off.
  const lockedClose = useCallback(() => undefined, [])

  const choose = async (mode: MigrationWorkMode) => {
    setError('')
    setPending(mode)
    try {
      await onChoose(mode)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPending(null)
    }
  }

  return (
    <Modal
      title={t('workModeMigration.title')}
      description={t('workModeMigration.body')}
      onClose={lockedClose}
      locked
      showCloseButton={false}
      panelClassName="w-[560px]"
    >
      <div className="space-y-3">
        {options.map(({ mode, icon: Icon, titleKey, hintKey }) => (
          <button
            key={mode}
            type="button"
            disabled={pending !== null}
            aria-busy={pending === mode}
            onClick={() => void choose(mode)}
            className="w-full rounded-lg border border-border p-4 text-left transition-colors enabled:hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
          >
            <div className="flex items-center gap-2">
              <Icon className="h-5 w-5 text-muted-foreground" aria-hidden />
              <span className="text-sm font-semibold">{t(titleKey)}</span>
              {pending === mode && (
                <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" aria-hidden />
              )}
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t(hintKey)}</p>
          </button>
        ))}
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('workModeMigration.ownServerHint', { section: t('nav.voiceEngine') })}
        </p>
        {error && <p role="alert" className="text-sm leading-6 text-destructive">{error}</p>}
      </div>
    </Modal>
  )
}

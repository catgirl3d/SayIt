import { useEffect, useRef, useState } from 'react'
import { Info } from 'lucide-react'
import { Feedback } from '@/components/ui/feedback'
import { Select } from '@/components/ui/select'
import { Tooltip } from '@/components/ui/tooltip'
import { useT } from '@/i18n/useT'
import { getSetting, setSetting } from '@/services/store'
import { CONTEXT_SELECTION_AI_PROFILE_KEY } from '@/services/transcription/selectionAi'
import { loadAiProfiles } from './aiProfileStore'
import { isProfileComplete, profileSubtitle, profileTitle, type AiProfile } from './aiProviderCatalog'

const helpIconClass = 'h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50'

/**
 * Choose a saved AI service for selected-text editing. The empty value keeps the current
 * dictation model. Services that are not configured yet cannot be picked, but a saved
 * choice that became incomplete stays visible so the warning explains what happened.
 */
export default function ContextSelectionModelSetting() {
  const t = useT()
  const [profiles, setProfiles] = useState<AiProfile[]>([])
  const [profileId, setProfileId] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<'load' | 'save' | null>(null)
  const revision = useRef(0)
  const savingRef = useRef(false)
  const loadInFlightRef = useRef(0)
  const pendingReloadRef = useRef(false)
  const loadRef = useRef<() => Promise<void>>(async () => {})

  useEffect(() => {
    let disposed = false
    const load = async () => {
      // A save owns the field while it runs. Remember the request instead of dropping it,
      // so a profile change that raced the save is replayed once the save settles.
      if (savingRef.current) {
        pendingReloadRef.current = true
        return
      }
      loadInFlightRef.current += 1
      const current = ++revision.current
      try {
        const [state, selectedId] = await Promise.all([
          loadAiProfiles(),
          getSetting(CONTEXT_SELECTION_AI_PROFILE_KEY, ''),
        ])
        if (disposed || current !== revision.current) return
        setProfiles(state.profiles)
        setProfileId(String(selectedId || ''))
        setError(null)
      } catch {
        if (!disposed && current === revision.current) setError('load')
      } finally {
        loadInFlightRef.current -= 1
        if (!disposed && current === revision.current) setLoading(false)
      }
    }
    loadRef.current = load
    void load()
    window.addEventListener('ai-profiles-changed', load)
    window.addEventListener('focus', load)
    return () => {
      disposed = true
      window.removeEventListener('ai-profiles-changed', load)
      window.removeEventListener('focus', load)
    }
  }, [])

  const save = async (nextId: string) => {
    if (savingRef.current) return
    savingRef.current = true
    // A load already in flight will be discarded by the revision bump below; replay it once
    // after the save so a profile change that raced the save is not lost.
    if (loadInFlightRef.current > 0) pendingReloadRef.current = true
    revision.current += 1
    setSaving(true)
    try {
      await setSetting(CONTEXT_SELECTION_AI_PROFILE_KEY, nextId)
      setProfileId(nextId)
      setError(null)
    } catch {
      setError('save')
    } finally {
      savingRef.current = false
      setSaving(false)
      if (pendingReloadRef.current) {
        pendingReloadRef.current = false
        void loadRef.current()
      }
    }
  }

  const selected = profiles.find((profile) => profile.id === profileId)
  const missing = Boolean(profileId && !selected)
  const incomplete = Boolean(selected && !isProfileComplete(selected))
  const options = [
    { value: '', label: t('settings.contextAware.sameModel') },
    ...(missing ? [{ value: profileId, label: t('settings.contextAware.modelMissingOption') }] : []),
    ...profiles
      // Offer only complete services, plus the saved one even if it is incomplete, so the
      // user can see the warning and switch away from it.
      .filter((profile) => profile.id === profileId || isProfileComplete(profile))
      .map((profile) => ({
        value: profile.id,
        label: isProfileComplete(profile)
          ? `${profileTitle(profile)} · ${profileSubtitle(profile)}`
          : `${profileTitle(profile)} · ${profileSubtitle(profile)} — ${t('ai.status.incomplete')}`,
      })),
  ]

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <p id="context-selection-model-label" className="text-sm font-medium">
            {t('settings.contextAware.model')}
          </p>
          <Tooltip variant="light" content={t('settings.contextAware.modelDesc')}>
            <Info
              aria-label={t('settings.helpAria', { label: t('settings.contextAware.model') })}
              className={helpIconClass}
            />
          </Tooltip>
        </div>
        <Select
          value={profileId}
          onChange={(value) => void save(value)}
          options={options}
          labelledBy="context-selection-model-label"
          disabled={loading || saving || error === 'load'}
          className="w-full max-w-full sm:w-64"
        />
      </div>
      {!loading && !profiles.length && !error && (
        <p className="text-xs text-muted-foreground">{t('settings.contextAware.modelEmpty')}</p>
      )}
      {missing && !error && <Feedback tone="warning" message={t('settings.contextAware.modelMissing')} />}
      {incomplete && !error && <Feedback tone="warning" message={t('settings.contextAware.modelIncomplete')} />}
      {error && (
        <Feedback
          tone="error"
          message={t(error === 'load'
            ? 'settings.contextAware.modelLoadError'
            : 'settings.contextAware.modelSaveError')}
        />
      )}
    </div>
  )
}

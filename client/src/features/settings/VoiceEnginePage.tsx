// Voice engine settings page — work mode, ASR service configuration, and recognition test

import { useEffect, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { getDefault } from '@/services/defaults'
import { getSetting } from '@/services/store'
import { getWorkMode, type WorkMode } from '@/services/transcription'
import { applyWorkMode } from '@/services/transcription/applyWorkMode'
import { setSpeechLanguageCache } from '@/services/recorder'
import {
  getSpeechInputLanguage,
  setSpeechInputLanguage,
  type SpeechInputLanguage,
} from '@/services/speechInputLanguage'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import WorkModeSection from './WorkModeSection'
import CloudAPISection from './CloudAPISection'
import LocalModeSection, { LocalModeAdvancedSection } from './LocalModeSection'
import ServerSection from './ServerSection'
import AsrTestSection from './AsrTestSection'
import { PageHelp } from './PageHelp'
import { VoiceEngineHelpContent } from './HelpContents'
import { useT } from '@/i18n/useT'
import SpeechLanguageSection from './SpeechLanguageSection'

export default function VoiceEnginePage() {
  const t = useT()
  const [workMode, setWorkMode] = useState<WorkMode>(getWorkMode)
  const [speechLanguage, setSpeechLanguage] = useState<SpeechInputLanguage>('auto')
  // Local-mode advanced settings start collapsed. The four cards used to have the same visual weight as
  // "choose a model", leaving seven peer headings and 27 controls on one screen with no clear priority.
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [workModeError, setWorkModeError] = useState<string>('')

  useEffect(() => {
    void getSpeechInputLanguage().then(setSpeechLanguage)
    getSetting('workMode', getDefault<WorkMode>('workMode')).then((value) => {
      const v = value as WorkMode
      if (v === 'server' || v === 'cloud_api' || v === 'local') setWorkMode(v)
    })
  }, [])

  const handleWorkModeChange = async (mode: WorkMode) => {
    setWorkModeError('')
    try {
      await applyWorkMode(mode)
    } catch (error) {
      setWorkModeError(error instanceof Error ? error.message : String(error))
      return
    }
    // Switching modes replaces the configuration cards below, so unsaved input from the previous mode disappears.
    // Clear the dirty flag with it; otherwise the recognition test keeps reporting stale unsaved changes.
    setEngineDraftDirty(false)
    setWorkMode(mode)
  }

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 text-2xl font-bold">{t('nav.voiceEngine')}</h1>
          <p className="text-sm text-muted-foreground">{t('voiceEngine.subtitle')}</p>
        </div>
        <PageHelp title={t('help.voiceEngine.title')}>
          <VoiceEngineHelpContent />
        </PageHelp>
      </div>

      <div className="space-y-6">
        <div className="space-y-2">
          <WorkModeSection value={workMode} onChange={(m) => void handleWorkModeChange(m)} />
          {workModeError && <p role="alert" className="text-sm leading-6 text-destructive">{workModeError}</p>}
        </div>
        <SpeechLanguageSection
          value={speechLanguage}
          onChange={(language) => {
            setSpeechLanguage(language)
            // Persist first, then update the cache: an interleaved refreshRecorderSettings() re-reads
            // the stored value, so the cache must never be newer than the persisted setting.
            void setSpeechInputLanguage(language).then(() => {
              setSpeechLanguageCache(language)
            })
          }}
        />

        {/* The id lets the "Needs setup" badge in the Work mode card scroll here. */}
        <div id="engine-config" className="space-y-6">
          {workMode === 'local' && <LocalModeSection speechLanguage={speechLanguage} />}
          {workMode === 'server' && <ServerSection speechLanguage={speechLanguage} />}
          {workMode === 'cloud_api' && <CloudAPISection speechLanguage={speechLanguage} />}
        </div>

        <AsrTestSection workMode={workMode} speechLanguage={speechLanguage} />

        {workMode === 'local' && (
          <section className="space-y-6">
            <button
              type="button"
              aria-expanded={advancedOpen}
              aria-controls="local-advanced"
              onClick={() => setAdvancedOpen(!advancedOpen)}
              className="flex w-full items-center gap-2 rounded-md px-1 py-2 text-left text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronDown
                className={`h-4 w-4 shrink-0 transition-transform ${advancedOpen ? 'rotate-180' : ''}`}
                aria-hidden
              />
              <span className="font-medium">{t('voiceEngine.advanced')}</span>
              <span className="text-xs">{t('voiceEngine.advancedDesc')}</span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </button>

            {advancedOpen && (
              <div id="local-advanced" className="space-y-6">
                <LocalModeAdvancedSection />
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { Info, Pencil, RotateCcw } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { refreshRecorderSettings } from '@/services/recorder'
import { getSetting, setSetting } from '@/services/store'
import {
  CONTEXT_SELECTION_EDIT_PROMPT,
  CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY,
  normalizeContextSelectionEditPrompt,
} from '@/services/contextAware'
import { useAiEnabled, useAiEnabledReady } from '@/hooks/useAiEnabled'
import { useT } from '@/i18n/useT'
import ContextSelectionModelSetting from './ContextSelectionModelSetting'

export default function ContextAwareSection() {
  const t = useT()
  const aiEnabled = useAiEnabled()
  const aiReady = useAiEnabledReady()
  const aiInactive = aiReady && !aiEnabled
  const [contextAwareWriting, setContextAwareWriting] = useState(false)
  const [contextPromptOpen, setContextPromptOpen] = useState(false)
  const [contextSelectionEditPrompt, setContextSelectionEditPrompt] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [contextPromptDraft, setContextPromptDraft] = useState(CONTEXT_SELECTION_EDIT_PROMPT)
  const [contextPromptSaving, setContextPromptSaving] = useState(false)
  // Hidden until the saved values are read, so the switch never flashes its default state.
  const [ready, setReady] = useState(false)
  // Transitions are enabled two frames after reveal so the saved value is not animated in from the default.
  const [animate, setAnimate] = useState(false)

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getSetting('contextAwareWritingEnabled', false).catch(() => false),
      getSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, CONTEXT_SELECTION_EDIT_PROMPT).catch(() => CONTEXT_SELECTION_EDIT_PROMPT),
    ])
      .then(([enabled, prompt]) => {
        if (cancelled) return
        setContextAwareWriting(Boolean(enabled))
        const p = normalizeContextSelectionEditPrompt(prompt)
        setContextSelectionEditPrompt(p)
        setContextPromptDraft(p)
      })
      .finally(() => {
        if (cancelled) return
        setReady(true)
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!cancelled) setAnimate(true)
        }))
      })
    return () => { cancelled = true }
  }, [])

  const toggleContextAwareWriting = async () => {
    const next = !contextAwareWriting
    setContextAwareWriting(next)
    await setSetting('contextAwareWritingEnabled', next)
    await refreshRecorderSettings()
  }

  const openContextPrompt = () => {
    setContextPromptDraft(contextSelectionEditPrompt)
    setContextPromptOpen(true)
  }

  const saveContextPrompt = async () => {
    const prompt = contextPromptDraft.trim()
    if (!prompt || contextPromptSaving) return
    setContextPromptSaving(true)
    const normalized = normalizeContextSelectionEditPrompt(prompt)
    try {
      await setSetting(CONTEXT_SELECTION_EDIT_PROMPT_SETTING_KEY, normalized)
      setContextSelectionEditPrompt(normalized)
      setContextPromptDraft(normalized)
      await refreshRecorderSettings()
      setContextPromptOpen(false)
    } finally {
      setContextPromptSaving(false)
    }
  }

  const resetContextPrompt = () => {
    setContextPromptDraft(CONTEXT_SELECTION_EDIT_PROMPT)
  }

  return (
    <>
      <Card>
        <CardContent className="space-y-4 p-6">
          <div className={`flex items-center gap-1.5 ${aiInactive ? 'opacity-60' : ''}`}>
            <h2 id="context-aware-heading" className="text-lg font-semibold">{t('settings.contextAware.title')}</h2>
            <Tooltip
              variant="light"
              content={(
                <div className="w-[32rem] max-w-[calc(100vw-3rem)] space-y-2">
                  <p>{t('settings.contextAware.infoFunction')}</p>
                  <p>{t('settings.contextAware.infoUsage')}</p>
                  <p>{t('settings.contextAware.infoPrinciple')}</p>
                </div>
              )}
            >
              <Info
                aria-label={t('settings.contextAware.infoAria')}
                className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground/50 transition-colors hover:text-muted-foreground"
              />
            </Tooltip>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p id="context-aware-label" className={`text-sm font-medium ${aiInactive ? 'opacity-60' : ''}`}>{t('settings.contextAware.enable')}</p>
              <p className={`text-xs text-muted-foreground ${aiInactive ? 'opacity-60' : ''}`}>
                {t('settings.contextAware.descContinue')}
              </p>
              {aiInactive && (
                <p className="mt-0.5 text-xs text-foreground">
                  {t('settings.contextAware.needsAi')}
                </p>
              )}
            </div>
            <Switch labelledBy="context-aware-label" checked={contextAwareWriting} onChange={() => void toggleContextAwareWriting()} disabled={aiInactive} className={aiInactive ? 'opacity-60' : ''} noAnimation={!animate} hidden={!ready} />
          </div>

          <div className={`flex items-center justify-between border-t border-border pt-4 ${aiInactive ? 'opacity-60' : ''}`}>
            <div>
              <p className="text-sm font-medium">{t('settings.contextAware.promptTitle')}</p>
              <p className="text-xs text-muted-foreground">{t('settings.contextAware.promptDesc')}</p>
            </div>
            <button
              type="button"
              onClick={openContextPrompt}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Pencil className="h-3.5 w-3.5" />
              {t('settings.contextAware.editPrompt')}
            </button>
          </div>
          <div className={aiInactive ? 'opacity-60' : ''}>
            <ContextSelectionModelSetting />
          </div>
        </CardContent>
      </Card>

      {contextPromptOpen && (
        <Modal onClose={() => setContextPromptOpen(false)} title={t('settings.contextAware.promptTitle')}>
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">{t('settings.contextAware.promptDesc')}</p>
            <textarea
              value={contextPromptDraft}
              onChange={(e) => setContextPromptDraft(e.target.value)}
              aria-label={t('settings.contextAware.promptEditorAria')}
              rows={8}
              className="w-full rounded-md border border-border bg-input p-3 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/50 focus:border-primary focus:outline-none"
              placeholder={CONTEXT_SELECTION_EDIT_PROMPT}
            />
            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                onClick={resetContextPrompt}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('settings.contextAware.resetPrompt')}
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setContextPromptOpen(false)}
                  className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="button"
                  onClick={() => void saveContextPrompt()}
                  disabled={contextPromptSaving || !contextPromptDraft.trim()}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {contextPromptSaving ? t('settings.contextAware.savingPrompt') : t('common.save')}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}

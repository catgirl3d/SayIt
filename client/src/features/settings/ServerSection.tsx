// Server mode settings — service address + connection status

import { useEffect, useState } from 'react'
import { Info } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tooltip } from '@/components/ui/tooltip'
import { Feedback, type FeedbackTone } from '@/components/ui/feedback'
import {
  getBackendBaseUrl,
  getDefaultBackendBaseUrl,
  resetBackendBaseUrl,
  setBackendBaseUrl as persistBackendBaseUrl,
} from '@/services/runtimeConfig'
import { reconnectProvider } from '@/services/recorder'
import type { SpeechInputLanguage } from '@/services/speechInputLanguage'
import { setEngineDraftDirty } from '@/stores/engineDraft'
import { describeServerError } from '@/lib/errorMessages'
import { useT } from '@/i18n/useT'

interface ServiceResult {
  tone: FeedbackTone
  message: string
  detail?: string
}

export default function ServerSection({ speechLanguage }: { speechLanguage: SpeechInputLanguage }) {
  const t = useT()
  const [backendBaseUrl, setBackendBaseUrl] = useState('')
  /** Saved address. Any difference from the input box means "unsaved" */
  const [savedBaseUrl, setSavedBaseUrl] = useState('')
  const [defaultBaseUrl, setDefaultBaseUrl] = useState('')
  const [result, setResult] = useState<ServiceResult | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const current = getBackendBaseUrl()
    setBackendBaseUrl(current)
    setSavedBaseUrl(current)
    setDefaultBaseUrl(getDefaultBackendBaseUrl())
    // Reset the "unsaved changes" flag when leaving the route — do not leave the dirty state behind for the next visit
    return () => setEngineDraftDirty(false)
  }, [])

  const normalize = (v: string) => v.trim().replace(/\/+$/, '')

  const isDirty = normalize(backendBaseUrl) !== normalize(savedBaseUrl)
  const isCustom = normalize(savedBaseUrl) !== normalize(defaultBaseUrl)

  function handleUrlChange(value: string) {
    setBackendBaseUrl(value)
    setResult(null)
    setEngineDraftDirty(normalize(value) !== normalize(savedBaseUrl))
  }

  interface HealthPayload {
    asr?: boolean
    asr_engine?: string
    asr_model?: string
    llm?: boolean
  }

  /** Probe /healthz once. On success returns the ASR/LLM switches and model info the backend reports; on failure throws the original error. */
  async function probeHealth(url: string): Promise<HealthPayload> {
    const response = await fetch(`${url}/healthz`, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return await response.json() as HealthPayload
  }

  /** Translate the /healthz asr/llm and model info into plain language. */
  function describeHealth(payload: HealthPayload, prefix: string): ServiceResult {
    const modelDetail = payload.asr_model ? ` · ASR: ${payload.asr_model}` : ''
    const languageDetail = payload.asr_engine === 'qwen3'
      ? t('server.lang.applied', {
        lang: speechLanguage === 'auto' ? t('common.auto') : t(`local.lang.${speechLanguage}` as 'local.lang.en'),
      })
      : payload.asr_engine === 'gigaam' || payload.asr_engine === 'firered'
        ? t('server.lang.ignored')
        : undefined
    if (payload.asr === false) {
      return {
        tone: 'warning',
        message: t('server.asrNotReady', { prefix }),
        detail: languageDetail,
      }
    }
    if (payload.llm === false) {
      return {
        tone: 'success',
        message: t('server.noAi', { prefix }) + modelDetail,
        detail: languageDetail,
      }
    }
    return {
      tone: 'success',
      message: t('server.allGood', { prefix }) + modelDetail,
      detail: languageDetail,
    }
  }

  /**
   * Save and test.
   *
   * This used to be two equally-weighted buttons: "Test connection" only tested (using
   * the input value), "Save" saved and then tested. Users pressed the first, saw
   * "connection successful", and reasonably assumed the configuration had taken effect —
   * it had not. Merging both actions into one removes the "tested but not saved" state
   * from the UI entirely.
   */
  async function handleSaveAndTest() {
    if (busy) return
    const normalized = normalize(backendBaseUrl)
    if (!normalized) {
      setResult({ tone: 'warning', message: t('server.urlEmpty') })
      return
    }
    try {
      new URL(normalized)
    } catch {
      setResult({
        tone: 'warning',
        message: t('server.urlInvalid'),
      })
      return
    }

    setBusy(true)
    setResult(null)
    try {
      const next = await persistBackendBaseUrl(normalized)
      setBackendBaseUrl(next)
      setSavedBaseUrl(next)
      setEngineDraftDirty(false)
      // The address changed: force a reconnect on the new address regardless of the
      // health probe below, so the bottom-left connection indicator reflects the new
      // configuration (a wrong address must show "disconnected", not a stale "connected").
      reconnectProvider()
    } catch (error) {
      setResult({ tone: 'error', message: t('server.saveFailed'), detail: String(error) })
      setBusy(false)
      return
    }

    try {
      const payload = await probeHealth(normalized)
      setResult(describeHealth(payload, t('server.savedPrefix')))
    } catch (error) {
      const friendly = describeServerError(error, normalize(normalized) !== normalize(defaultBaseUrl))
      setResult({
        tone: 'error',
        message: t('server.savedButUnreachable', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setBusy(false)
    }
  }

  /** Restore the built-in default address and reconnect immediately, so the user does not have to remember the default */
  async function handleResetDefault() {
    if (busy) return
    setBusy(true)
    setResult(null)
    try {
      const next = await resetBackendBaseUrl()
      setBackendBaseUrl(next)
      setSavedBaseUrl(next)
      setEngineDraftDirty(false)
      reconnectProvider()
      const payload = await probeHealth(next)
      setResult(describeHealth(payload, t('server.restoredPrefix', { url: next })))
    } catch (error) {
      const friendly = describeServerError(error, false)
      setResult({
        tone: 'error',
        message: t('server.restoredButUnreachable', { message: friendly.message }),
        detail: friendly.detail,
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card>
        <CardContent className="p-6">
          <h2 className="text-lg font-semibold">{t('server.title')}</h2>
          <p className="mt-1 flex items-center gap-1 text-sm text-muted-foreground">
            {t('server.desc')}
            <Tooltip
              variant="light"
              content={t('server.help')}
            >
              <Info className="h-3.5 w-3.5 shrink-0 cursor-help text-muted-foreground transition-colors hover:text-foreground" />
            </Tooltip>
          </p>

          <div className="mt-4">
            <div className="mb-1.5 flex items-center gap-2">
              <label htmlFor="server-base-url" className="text-sm text-muted-foreground">
                {t('server.title')}
              </label>
              {/* The input value lives only in local state and is gone on page switch. This
                  used to be completely unsignaled, so users assumed an edit took effect. */}
              {isDirty && (
                <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning-strong">
                  {t('server.unsaved')}
                </span>
              )}
            </div>
            {/* flex-wrap: at the 800×600 minimum window the sidebar takes 192px, so the input + buttons on one line would overflow */}
            <div className="flex flex-wrap items-center gap-2">
              <input
                id="server-base-url"
                type="url"
                inputMode="url"
                value={backendBaseUrl}
                onChange={(e) => handleUrlChange(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveAndTest() }}
                placeholder={defaultBaseUrl || 'https://sayitapp.site'}
                className="h-9 min-w-[16rem] flex-1 rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border"
              />
              <Button size="sm" className="h-9 shrink-0" onClick={() => void handleSaveAndTest()} disabled={busy}>
                {busy ? t('server.savingAndTesting') : t('server.saveAndTest')}
              </Button>
              {isCustom && (
                <Button size="sm" variant="ghost" className="h-9 shrink-0" onClick={() => void handleResetDefault()} disabled={busy}>
                  {t('server.restoreDefault')}
                </Button>
              )}
            </div>
          </div>

          {/* The failure hint used to carry a second "restore default address (https://…)"
              button: first, it stuffed the whole URL into the button label — nowhere else
              in the app does that; second, it was exactly synonymous with the "restore
              default" button next to the input, which is always present once the address
              was changed and thus covers every case where this failure hint appears.
              Keeping one button is enough. */}
          {result && (
            <Feedback
              className="mt-3"
              tone={result.tone}
              message={result.message}
              detail={result.detail}
            />
          )}
          {!result && <p className="mt-3 text-xs text-muted-foreground">{t('server.lang.generic')}</p>}
        </CardContent>
      </Card>

    </>
  )
}

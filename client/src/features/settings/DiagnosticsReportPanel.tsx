import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CheckCircle2, FileArchive, RefreshCw } from 'lucide-react'
import { open } from '@tauri-apps/plugin-shell'
import { save } from '@tauri-apps/plugin-dialog'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { getDiagnosticsPreview, saveSupportBundle } from '@/services/diagnostics'
import { PROJECT_BUG_REPORT_URL } from '@/services/projectLinks'
import type { DiagnosticOccurrence, DiagnosticsPreview } from '@/types/appApi'
import { t } from '@/i18n'

interface DiagnosticsReportPanelProps {
  embedded?: boolean
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/50 py-2 last:border-b-0 last:pb-0 first:pt-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="max-w-[65%] break-all text-right text-sm text-foreground">{value}</span>
    </div>
  )
}

export default function DiagnosticsReportPanel({ embedded = false }: DiagnosticsReportPanelProps) {
  const [issueOccurrence, setIssueOccurrence] = useState<DiagnosticOccurrence>('within_1h')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<'idle' | 'saved' | 'error'>('idle')
  const [errorMessage, setErrorMessage] = useState('')
  const [preview, setPreview] = useState<DiagnosticsPreview | null>(null)
  const [loadingPreview, setLoadingPreview] = useState(false)
  const previewRequestId = useRef(0)

  const occurrenceOptions: Array<{ value: DiagnosticOccurrence; label: string }> = [
    { value: 'within_1h', label: t('diagnosticsReport.withinHour') },
    { value: 'today', label: t('diagnosticsReport.today') },
    { value: 'older', label: t('diagnosticsReport.older') },
  ]

  const loadPreview = useCallback((occurrence: DiagnosticOccurrence) => {
    const requestId = ++previewRequestId.current
    setLoadingPreview(true)
    setPreview(null)
    setErrorMessage('')
    void getDiagnosticsPreview(occurrence)
      .then((nextPreview) => {
        if (previewRequestId.current === requestId) setPreview(nextPreview)
      })
      .catch(() => {
        if (previewRequestId.current === requestId) setErrorMessage(t('diagnosticsReport.unavailable'))
      })
      .finally(() => {
        if (previewRequestId.current === requestId) setLoadingPreview(false)
      })
  }, [])

  useEffect(() => {
    loadPreview(issueOccurrence)
    return () => {
      previewRequestId.current += 1
    }
  }, [issueOccurrence, loadPreview])

  const refreshPreview = () => {
    loadPreview(issueOccurrence)
  }

  const handleSave = async () => {
    if (busy || loadingPreview) return
    setBusy(true)
    setStatus('idle')
    setErrorMessage('')
    try {
      const destination = await save({
        defaultPath: `sayit-support-bundle-${new Date().toISOString().slice(0, 10)}.zip`,
        filters: [{ name: t('diagnosticsReport.archiveFilter'), extensions: ['zip'] }],
      })
      if (!destination) return

      await saveSupportBundle(issueOccurrence, destination)
      setStatus('saved')
    } catch {
      setStatus('error')
      setErrorMessage(t('diagnosticsReport.createFailed'))
    } finally {
      setBusy(false)
    }
  }

  const handleReportIssue = async () => {
    try {
      await open(PROJECT_BUG_REPORT_URL)
    } catch {
      setErrorMessage(t('diagnosticsReport.openIssueFailed'))
    }
  }

  const containerClassName = embedded ? '' : 'mx-auto max-w-4xl p-8'
  const rangeLabel =
    occurrenceOptions.find((option) => option.value === issueOccurrence)?.label || t('diagnosticsReport.withinHour')

  return (
    <div className={containerClassName}>
      {!embedded && <h1 className="mb-6 text-2xl font-bold">{t('diagnostics.title')}</h1>}
      <Card>
        <CardContent className="p-6">
          <div className="mb-5 flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">{t('diagnosticsReport.publicTitle')}</h2>
              <p className="mt-1 text-sm text-muted-foreground">{t('diagnosticsReport.publicDesc')}</p>
            </div>
            <Button variant="outline" size="sm" onClick={refreshPreview} disabled={loadingPreview || busy}>
              <RefreshCw className={`mr-2 h-3.5 w-3.5 ${loadingPreview ? 'animate-spin' : ''}`} />
              {t('diagnosticsReport.refresh')}
            </Button>
          </div>

          <div className="space-y-5">
            <div>
              <label className="mb-2 block text-sm font-medium">{t('diagnosticsReport.when')}</label>
              <div className="flex flex-wrap gap-4">
                {occurrenceOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => setIssueOccurrence(option.value)}
                    className="flex items-center gap-2 text-sm text-foreground"
                    disabled={busy}
                  >
                    <span
                      className={`flex h-4 w-4 items-center justify-center rounded-full border ${issueOccurrence === option.value ? 'border-foreground' : 'border-muted-foreground/40'}`}
                    >
                      <span
                        className={`h-2.5 w-2.5 rounded-full ${issueOccurrence === option.value ? 'bg-foreground' : 'bg-transparent'}`}
                      />
                    </span>
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-md border border-border bg-muted p-4">
              <div className="mb-3 flex items-center gap-2 text-sm font-medium text-foreground">
                <FileArchive className="h-4 w-4" />
                {t('diagnosticsReport.publicContents')}
              </div>
              <p className="mb-3 text-xs text-muted-foreground">
                {t('diagnosticsReport.noRawLogs')} {t('diagnosticsReport.noSensitiveData')}
              </p>
              {preview ? (
                <div className="rounded-md border border-border/50 bg-card p-4 shadow-sm">
                  <SummaryRow label={t('diagnosticsReport.appVersion')} value={preview.systemInfo.appVersion} />
                  <SummaryRow label={t('diagnosticsReport.platform')} value={preview.systemInfo.platform} />
                  <SummaryRow label={t('diagnosticsReport.time')} value={preview.generatedAt} />
                  <SummaryRow label={t('diagnosticsReport.range')} value={rangeLabel} />
                  <SummaryRow
                    label={t('diagnosticsReport.filesScanned')}
                    value={t('diagnosticsReport.fileCount', { count: preview.filesScanned })}
                  />
                  <SummaryRow
                    label={t('diagnosticsReport.summary')}
                    value={t('diagnosticsReport.summaryValue', {
                      events: preview.totalTimelineEntries,
                      errors: preview.summary.errors,
                      warnings: preview.summary.warnings,
                    })}
                  />
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  {loadingPreview ? t('diagnosticsReport.loading') : t('diagnosticsReport.unavailable')}
                </div>
              )}
            </div>

            {errorMessage && (
              <div className="flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                {errorMessage}
              </div>
            )}
            {status === 'saved' && (
              <div className="flex items-start gap-2 rounded-md bg-success/10 p-3 text-sm">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
                <div>
                  <div className="font-medium text-success">{t('diagnosticsReport.savedPublic')}</div>
                  <div className="mt-1 text-xs text-success/80">{t('diagnosticsReport.notUploaded')}</div>
                  <Button variant="link" size="sm" className="h-auto px-0 text-xs" onClick={handleReportIssue}>
                    {t('diagnosticsReport.reportIssue')}
                  </Button>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setIssueOccurrence('within_1h')
                  setStatus('idle')
                  setErrorMessage('')
                }}
              >
                {t('diagnosticsReport.clear')}
              </Button>
              <Button size="sm" disabled={busy || loadingPreview} onClick={handleSave}>
                {busy ? t('diagnosticsReport.creatingBundle') : t('diagnosticsReport.createBundle')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

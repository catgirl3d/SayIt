import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check, Info, Loader2, Pause, Play, RotateCcw } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Button } from '@/components/ui/button'
import * as bridge from '@/services/bridge'
import { type HistoryRecord } from '@/services/store'
import {
  ASR_CORRECTION_WITHDRAW_DAYS,
  grantAsrCorrectionConsent,
  hasAsrCorrectionConsent,
  submitAsrCorrection,
  withdrawAsrCorrection,
} from '@/services/asrCorrection'
import { normalizeForDiff } from '@/lib/asrDiff'
import { t } from '@/i18n'
import { useT } from '@/i18n/useT'
import { useRecordingPlayback } from './useRecordingPlayback'
import { AudioProgressBar } from './AudioProgressBar'
import { AsrDiffPreview } from './AsrDiffPreview'

/**
 * The "correct recognition" panel.
 *
 * Three deliberate design decisions; read .kiro/decisions.md before changing them:
 * 1. The initial value of the editable field is **record.asrText (the raw recognized text)**,
 *    never llmText. What users normally see is the AI-polished text; if they edited that
 *    (adding punctuation, splitting paragraphs, rewording into written style), the annotations we
 *    would collect would be noise for ASR training, so the correction panel does not show the
 *    AI-polished text.
 * 2. Submission is blocked when the audio cannot be read. A sample without audio is of no use for
 *    improving recognition.
 * 3. The first submission must go through an explicit consent step (not just an info icon). What
 *    gets uploaded is the user's recording, which is far more sensitive than text.
 */
/**
 * Height cap of the editable field (px). The "recognized original" block above it is max-h-40
 * (160px); here it is 200px. The two blocks have identical line height, font size and padding, so
 * the same text takes the same height in both, and the block that is about to be edited is just
 * allowed to be a bit longer. Past the cap it scrolls internally instead of stretching the dialog
 * off the screen.
 */
const EDITOR_MAX_HEIGHT_PX = 200

export function AsrCorrectionDialog({
  record,
  onClose,
  onSubmitted,
}: {
  record: HistoryRecord
  onClose: () => void
  onSubmitted: (patch: Partial<HistoryRecord>) => void
}) {
  useT()
  const originalText = record.asrText || ''
  const [correctedText, setCorrectedText] = useState(record.asrCorrectedText || originalText)
  const [audioState, setAudioState] = useState<'checking' | 'ok' | 'missing'>('checking')
  const [consentNeeded, setConsentNeeded] = useState(false)
  const [consentChecked, setConsentChecked] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [withdrawing, setWithdrawing] = useState(false)
  const [error, setError] = useState('')
  const editorRef = useRef<HTMLTextAreaElement | null>(null)
  // Seed with the audio duration stored on the record, so the total length is visible even before
  // play is pressed (audioDurationSec is the real audio length; durationSec is how long the hotkey
  // was held, used only as a fallback for old records that lack the former)
  const playback = useRecordingPlayback(
    record.audioFilePath,
    record.audioDurationSec || record.durationSec || 0,
  )

  const submitted = Boolean(record.asrCorrectionId)

  useEffect(() => {
    let alive = true
    void (async () => {
      const path = record.audioFilePath
      if (!path) {
        if (alive) setAudioState('missing')
        return
      }
      const exists = await bridge.audioFileExists(path).catch(() => false)
      if (alive) setAudioState(exists ? 'ok' : 'missing')
    })()
    void (async () => {
      const granted = await hasAsrCorrectionConsent().catch(() => false)
      if (alive) setConsentNeeded(!granted)
    })()
    return () => { alive = false }
  }, [record.audioFilePath])

  /**
   * Makes the editable field grow with its content, matching the read-only "recognized original"
   * block above it: one line of content is one line tall, and past the cap it scrolls internally.
   *
   * Does not use the `rows={lineCount}` approach: `rows` only counts newline characters, so a long
   * text with no newlines that still wraps counts as a single line and the box ends up far shorter
   * than its content. So the height is measured from scrollHeight instead.
   *
   * `+ extra` is the top and bottom border: box-sizing is border-box, so height includes the
   * border while scrollHeight does not; without it the box would always be 2px too short, and a
   * scrollbar would appear the moment any content arrives.
   */
  useEffect(() => {
    const el = editorRef.current
    if (!el) return
    el.style.height = 'auto'
    const extra = el.offsetHeight - el.clientHeight
    el.style.height = `${Math.min(el.scrollHeight + extra, EDITOR_MAX_HEIGHT_PX)}px`
  }, [correctedText])

  const changed = normalizeForDiff(originalText) !== normalizeForDiff(correctedText)
  const canSubmit =
    !submitted &&
    audioState === 'ok' &&
    changed &&
    !submitting &&
    (!consentNeeded || consentChecked)

  const handleSubmit = useCallback(async () => {
    setError('')
    setSubmitting(true)
    try {
      if (consentNeeded) await grantAsrCorrectionConsent()
      const result = await submitAsrCorrection(record, correctedText)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setConsentNeeded(false)
      onSubmitted({
        asrCorrectionId: result.correctionId,
        asrCorrectionSubmittedAt: Date.now(),
        asrCorrectedText: normalizeForDiff(correctedText),
      })
    } finally {
      setSubmitting(false)
    }
  }, [consentNeeded, correctedText, onSubmitted, record])

  const handleWithdraw = useCallback(async () => {
    if (!record.asrCorrectionId) return
    setError('')
    setWithdrawing(true)
    try {
      const ok = await withdrawAsrCorrection(record.asrCorrectionId)
      if (!ok) {
        setError(t('asrCorrection.errorNetwork'))
        return
      }
      // Clear it locally too, so the entry returns to "submittable".
      // Must write null rather than undefined: the patch goes through JSON.stringify, which drops
      // keys whose value is undefined, so the field would not be cleared and the UI would keep
      // showing "submitted" (see the comment on HistoryRecord).
      onSubmitted({
        asrCorrectionId: null,
        asrCorrectionSubmittedAt: null,
        asrCorrectedText: null,
      })
    } finally {
      setWithdrawing(false)
    }
  }, [onSubmitted, record.asrCorrectionId])

  return (
    <Modal title={t('asrCorrection.title')} onClose={onClose} showCloseButton panelClassName="w-[620px]">
      <div className="mt-3 space-y-3">
        {/* Recording */}
        {audioState === 'missing' ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden />
            <span>{t('asrCorrection.audioMissing')}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => { void playback.toggle() }}
              disabled={playback.loading || audioState !== 'ok'}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border hover:bg-accent disabled:opacity-50"
              aria-label={playback.playing ? t('record.pause') : t('record.play')}
            >
              {playback.loading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" aria-hidden />
              ) : playback.playing ? (
                <Pause className="h-3.5 w-3.5 text-primary" aria-hidden />
              ) : (
                <Play className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
              )}
            </button>
            <AudioProgressBar playback={playback} className="min-w-0 flex-1" />
          </div>
        )}

        {/* The recognized original and the change markers are merged into one block.
            There used to be two boxes, a "read-only original" and a "change preview", but the diff
            already contains the full original (the deleted parts are struck through), so two boxes
            side by side showed the same passage twice. Together with the editable box that made
            three boxes, and merely finding "where do I type" took a moment. With the merge only two
            remain: one to look at and one to edit. */}
        <AsrDiffPreview original={originalText} corrected={correctedText} />

        {/* Corrected text (editable) */}
        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <label htmlFor="asr-correction-input" className="block text-xs font-medium text-foreground">
              {t('asrCorrection.correctedLabel')}
            </label>
            {/* Lets the user start over after a botched edit without retyping the original by hand */}
            <button
              type="button"
              onClick={() => setCorrectedText(originalText)}
              disabled={!changed || submitted || submitting}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
            >
              <RotateCcw className="h-3 w-3" aria-hidden />
              {t('asrCorrection.reset')}
            </button>
          </div>
          {/* Padding, font size and line height match the "recognized original" block so the two
              line up; the height is computed by the effect above, so manual dragging is turned off
              (it would be recomputed back as soon as the user typed after a drag). */}
          <textarea
            ref={editorRef}
            id="asr-correction-input"
            data-modal-autofocus
            value={correctedText}
            onChange={(e) => setCorrectedText(e.target.value)}
            disabled={submitted || submitting}
            rows={1}
            className="w-full resize-none overflow-y-auto rounded-md border border-input-border bg-input-bg px-2.5 py-2 text-sm leading-relaxed focus:border-input-focus-border focus:outline-none disabled:opacity-60"
          />
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{t('asrCorrection.correctedHint')}</p>
        </div>

        {/* Consent: required on the first submission; afterwards only an info icon remains */}
        {!submitted && (consentNeeded ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-muted/30 px-2.5 py-2 text-xs leading-relaxed">
            <input
              type="checkbox"
              checked={consentChecked}
              onChange={(e) => setConsentChecked(e.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
            />
            <span className="text-muted-foreground">
              {t('asrCorrection.consent', { days: ASR_CORRECTION_WITHDRAW_DAYS })}
            </span>
          </label>
        ) : (
          <div className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
            <span>{t('asrCorrection.consent', { days: ASR_CORRECTION_WITHDRAW_DAYS })}</span>
          </div>
        ))}

        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          {submitted ? (
            <>
              <span className="mr-auto flex items-center gap-1.5 text-xs text-success">
                <Check className="h-3.5 w-3.5" aria-hidden />
                {t('asrCorrection.submittedWithId', { id: record.asrCorrectionId || '' })}
              </span>
              <Button variant="outline" size="sm" onClick={() => { void handleWithdraw() }} disabled={withdrawing}>
                {withdrawing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
                {t('asrCorrection.withdraw')}
              </Button>
              <Button size="sm" onClick={onClose}>{t('common.close')}</Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => { void handleSubmit() }} disabled={!canSubmit}>
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden />}
                {t('asrCorrection.submit')}
              </Button>
            </>
          )}
        </div>
      </div>
    </Modal>
  )
}

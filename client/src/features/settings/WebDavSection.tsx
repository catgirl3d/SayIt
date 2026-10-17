// Settings panel for automatic WebDAV backup.
//
// Division of labor: **the card face answers "what is happening now", the dialog answers
// "how is it configured".**
//
// This card used to mix two things: the one-time server setup, and the everyday viewing and
// triggering of backups. The former is never touched again once it is done, and keeping it
// permanently on the settings page was the main source of noise (address, account, password, the
// Nutstore note, the test button, the test result: seven groups of elements taking up half the
// card, used once a year).
//
// Now:
// - Card face: one line of description + a one-line summary of "where it is connected, what gets
//   backed up, how often" + one primary action + one status line. When nothing is configured
//   there is only the description and a single button in the top-right corner: the vast majority
//   of users will never turn this feature on, so the default state should not hand them a whole
//   surface of controls.
// - Dialog: address and credentials, **backup content**, frequency, retention count. The backup
//   content has to be here because on first setup the user should see "what will be uploaded" and
//   choose on the spot, instead of discovering it on the card face after clicking Done. All three
//   items (configuration / history / recordings) are listed, and the configuration item shows
//   "Always included" rather than being hidden: the question "which files get synced" needs a
//   visible, complete answer.
// - When recordings are turned on, a line of hint appears **in place**, with no second-level
//   confirmation dialog: a dialog inside a dialog is an anti-pattern, and a permanent hint is more
//   useful than a confirmation that disappears after one click (as long as recordings are on, the
//   cost stays written right there).
//
// No feature was lost; what moved into the dialog is still reachable, it just no longer competes
// with the everyday actions for attention.
//
// Two more choices that have nothing to do with visuals but are just as deliberate:
// - The tier (whether history and recordings are included) lives only in the settings; manual and
//   scheduled backups both read the settings, so whatever is ticked in the UI is exactly what gets
//   uploaded.
// - Recordings are off by default. A recording library can reach several GB, and cloud drives have
//   a monthly upload traffic quota, so turning it on by default would make a very expensive
//   decision for the user.

import { useEffect, useState } from 'react'
import { CloudUpload, Loader2, RotateCcw, Settings2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Modal } from '@/components/ui/modal'
import { PasswordInput } from '@/components/ui/password-input'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Tooltip } from '@/components/ui/tooltip'
import { FormatHint } from '@/components/ui/feedback'
import { getSetting, setSetting } from '@/services/store'
import { restartApp } from '@/services/backup'
import {
  describeWebDavError,
  listWebDavBackups,
  onWebDavBackupProgress,
  restoreWebDavBackup,
  testWebDavConnection,
  DEFAULT_DAV_URL,
  type WebDavEntry,
  type WebDavLastResult,
  type WebDavProgress,
} from '@/services/webdavBackup'
import {
  onWebDavBackupChange,
  refreshLastResult,
  runBackupNow,
} from '@/features/backup/autoWebdavBackup'
import { formatBytes } from '@/lib/utils'
import type { TranslationKey } from '@/i18n'
import { useT } from '@/i18n/useT'

const inputClass =
  'h-9 w-full rounded-md border border-input-border bg-input-bg px-3 text-sm transition-colors focus:border-input-focus-border'

/**
 * Icon button on the card, in the same style as the ones on the "AI providers" service cards.
 *
 * One difference from those: here the icons are **not revealed only on hover**. The grid there
 * holds three to five cards, and always-visible icons would be noisy; here there is a single card,
 * and hiding them would only make "Back up now" impossible to find.
 */
const cardIconButtonClass =
  'rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40'

const phaseLabelKeys: Record<WebDavProgress['phase'], TranslationKey> = {
  preparing: 'backup.status.preparing',
  packingData: 'backup.status.packingData',
  packingAudio: 'backup.status.packingAudio',
  finalizing: 'backup.status.finalizing',
  uploading: 'webdav.status.uploading',
  verifying: 'webdav.status.verifying',
  completed: 'backup.status.completed',
  failed: 'backup.status.failed',
}

const intervalOptions = [
  { value: 24, labelKey: 'webdav.interval.daily' },
  { value: 72, labelKey: 'webdav.interval.every3Days' },
  { value: 168, labelKey: 'webdav.interval.weekly' },
] as const satisfies readonly { value: number; labelKey: TranslationKey }[]

/**
 * Each of the four tiers has its own complete sentence, instead of gluing "Settings" and "History"
 * together. Gluing is barely readable in Chinese, and in other languages it produces malformed
 * mixed-language strings, an English fragment followed by a word from another language.
 */
const contentSummaryKeys: Record<string, TranslationKey> = {
  'false,false': 'webdav.summary.config',
  'true,false': 'webdav.summary.configHistory',
  'false,true': 'webdav.summary.configAudio',
  'true,true': 'webdav.summary.all',
}

type Busy = 'test' | 'list' | 'restore' | null

/** The card face only needs to show "where it is connected". The scheme is always https, so displaying it is eight characters of noise. */
function shortServer(url: string): string {
  return url.trim().replace(/^https:\/\//i, '').replace(/\/+$/, '')
}

/** Time in the summary line. A full toLocaleString takes too much room on an 11px line, and nobody reads the year. */
function shortTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function WebDavSection() {
  const t = useT()

  // ready controls "show only once the values are in place", animate controls "allow transitions
  // only after two frames". Merging them into one flag does not fix the control moving on its own:
  // if the transition is added back in the very frame the content is revealed, the browser really
  // animates "default value -> saved value" (see the settings-controls entry in pitfalls).
  const [ready, setReady] = useState(false)
  const [animate, setAnimate] = useState(false)

  const [enabled, setEnabled] = useState(false)
  const [url, setUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [includeHistory, setIncludeHistory] = useState(false)
  const [includeAudio, setIncludeAudio] = useState(false)
  const [intervalHours, setIntervalHours] = useState(24)
  const [keepCount, setKeepCount] = useState(5)

  const [busy, setBusy] = useState<Busy>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<WebDavProgress | null>(null)
  const [lastResult, setLastResult] = useState<WebDavLastResult | null>(null)
  const [testMessage, setTestMessage] = useState('')
  const [actionError, setActionError] = useState('')

  const [serverOpen, setServerOpen] = useState(false)
  const [restoreList, setRestoreList] = useState<WebDavEntry[] | null>(null)
  const [restoreTarget, setRestoreTarget] = useState<WebDavEntry | null>(null)
  const [restoreDone, setRestoreDone] = useState(false)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const [en, u, name, pass, hist, audio, interval, keep] = await Promise.all([
        getSetting('webdav.enabled', false).catch(() => false),
        getSetting('webdav.url', '').catch(() => ''),
        getSetting('webdav.username', '').catch(() => ''),
        getSetting('webdav.password', '').catch(() => ''),
        getSetting('webdav.includeHistory', false).catch(() => false),
        getSetting('webdav.includeAudio', false).catch(() => false),
        getSetting('webdav.intervalHours', 24).catch(() => 24),
        getSetting('webdav.keepCount', 5).catch(() => 5),
      ])
      if (cancelled) return
      setEnabled(en)
      // The address is pre-filled with Nutstore, but it **must be persisted at the same time**: the
      // Rust side reads the database directly when backing up, while getSetting's default lives only
      // in frontend memory. If the user filled in only the account and password and never touched
      // the address field, that row would be missing from the database and the backup would fail
      // with "address is empty" — even though the UI plainly shows an address.
      if (u.trim()) {
        setUrl(u)
      } else {
        setUrl(DEFAULT_DAV_URL)
        await setSetting('webdav.url', DEFAULT_DAV_URL).catch(() => undefined)
      }
      setUsername(name)
      setPassword(pass)
      setIncludeHistory(hist)
      setIncludeAudio(audio)
      if (interval === 24 || interval === 72 || interval === 168) setIntervalHours(interval)
      if (keep === 3 || keep === 5 || keep === 10) setKeepCount(keep)
      setLastResult(await refreshLastResult())
      setReady(true)
      // Allow transitions only after two frames: the first frame is used to paint the saved values.
      requestAnimationFrame(() => requestAnimationFrame(() => { if (!cancelled) setAnimate(true) }))
    })()
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    const unlisten = onWebDavBackupProgress(setProgress)
    return () => { void unlisten.then((fn) => fn()) }
  }, [])

  // The scheduled background backup changes the state too, and the panel has to follow it; otherwise the user sees a snapshot from the moment the settings were opened.
  useEffect(() => {
    const off = onWebDavBackupChange((state) => {
      setRunning(state.running)
      setLastResult(state.lastResult)
    })
    return off
  }, [])

  // Configured once all three are filled in. The dialog saves as the user types, so this value is also exactly whether "Test connection" can be clicked.
  const configured = Boolean(url.trim() && username.trim() && password)
  const isBusy = busy !== null || running

  /**
   * In-place warning for the address field.
   *
   * The description text deliberately does not say "must be https": someone who typed it correctly
   * does not need to be told the rule, only someone who typed it wrong does, and then a targeted
   * warning is more useful than a permanent rule. So this has to cover **every** non-https case,
   * not just `http://`: if only http were checked, pasting a bare domain
   * (`dav.jianguoyun.com/dav`) would get no hint at all until the connection test fails.
   */
  const urlWarning = (() => {
    const value = url.trim().toLowerCase()
    if (!value) return null
    if (value.startsWith('http://')) return t('webdav.error.urlInsecure')
    if (!value.startsWith('https://')) return t('webdav.error.urlScheme')
    return null
  })()

  const patch = async <T,>(key: string, value: T, apply: (value: T) => void) => {
    apply(value)
    await setSetting(key, value)
  }

  const closeServerDialog = () => {
    setServerOpen(false)
    setTestMessage('')
    setActionError('')
  }

  const handleTest = async () => {
    setBusy('test')
    setTestMessage('')
    setActionError('')
    try {
      const count = await testWebDavConnection({ url, username, password })
      setTestMessage(t('webdav.testOk', { count }))
    } catch (error) {
      setActionError(describeWebDavError(error))
    } finally {
      setBusy(null)
    }
  }

  const handleOpenRestore = async () => {
    setBusy('list')
    setActionError('')
    try {
      setRestoreList(await listWebDavBackups())
    } catch (error) {
      setActionError(describeWebDavError(error))
    } finally {
      setBusy(null)
    }
  }

  const handleRestore = async () => {
    if (!restoreTarget) return
    const name = restoreTarget.name
    setRestoreTarget(null)
    setRestoreList(null)
    setBusy('restore')
    setActionError('')
    try {
      await restoreWebDavBackup(name)
      setRestoreDone(true)
      // Same as the local import: hold the notice briefly so the user can see
      // it, then restart so the restored data is applied.
      setTimeout(() => {
        void restartApp().catch((error) => {
          // The restore itself succeeded; only the restart could not be
          // scheduled, so surface that without reopening the restore flow.
          setRestoreDone(false)
          setBusy(null)
          setActionError(t('backup.restartFailed', { message: String(error) }))
        })
      }, 1500)
    } catch (error) {
      setActionError(describeWebDavError(error))
      setBusy(null)
    }
  }

  const uploading = progress?.status === 'running'
  const percent = Math.max(0, Math.min(100, progress?.percent ?? 0))
  const contentSummary = t(contentSummaryKeys[`${includeHistory},${includeAudio}`])
  const intervalLabel = t(
    intervalOptions.find((opt) => opt.value === intervalHours)?.labelKey ?? 'webdav.interval.daily',
  )

  /**
   * Status badge, written the same way as the one on the "AI providers" cards (same corner radius,
   * font size and color vocabulary). While a backup runs it shows only the percentage: the phase
   * name ("Packing recording files…") is too long, and putting it in the badge would squeeze out
   * the address, so it goes in the progress line below.
   */
  const chip = uploading
    ? { text: `${Math.round(percent)}%`, box: 'bg-warning/10 text-warning-strong' }
    : lastResult?.ok
      ? { text: t('webdav.state.ok'), box: 'bg-success/10 text-success-strong' }
      : lastResult
        ? { text: t('webdav.state.failed'), box: 'bg-destructive/10 text-destructive-strong' }
        : { text: t('webdav.state.never'), box: 'bg-muted text-muted-foreground' }

  // Summary: what is backed up · how often (only when automatic backup is on) · when last · how large
  const metaParts = [contentSummary]
  if (enabled) metaParts.push(intervalLabel)
  if (lastResult) metaParts.push(shortTime(lastResult.at))
  if (lastResult?.ok) metaParts.push(formatBytes(lastResult.bytes))

  return (
    <Card>
      <CardContent className="p-6">
        {/* items-center is the existing pattern for card headers on this page (the audio card and the
            log card both use it): the control on the right is centered against the whole title +
            description block. With items-start a 32px-tall button would crowd the 28px title row
            and look like it sags downward; also, the "Configure server" button and the "Automatic
            backup" switch differ in height, so with top alignment the right-hand content of the two
            states would be offset. */}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold">{t('webdav.title')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('webdav.desc')}</p>
          </div>
          {/* The top-right slot is this card's switch position: before configuration it is the only
              entry point, and once configured it becomes the automatic backup switch. An entry
              button placed on its own under the description would look like an isolated action that
              does not match the rest of the card. */}
          <div className="flex shrink-0 items-center gap-2">
            {configured ? (
              <>
                <span className="text-sm text-muted-foreground" id="webdav-enabled-label">
                  {t('webdav.autoLabel')}
                </span>
                <Switch
                  checked={enabled}
                  labelledBy="webdav-enabled-label"
                  onChange={() => void patch('webdav.enabled', !enabled, setEnabled)}
                  noAnimation={!animate}
                  hidden={!ready}
                />
              </>
            ) : (
              <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setServerOpen(true)}>
                <Settings2 className="h-4 w-4" />
                {t('webdav.configure')}
              </Button>
            )}
          </div>
        </div>

        {configured && (
          <>
            {/* The backup target is a small bordered card, written the same way as the "AI providers"
                service cards: address + status badge on one line, summary on the next. These used to
                be three runs of loose text with no container, sandwiched between the title and the
                buttons, which read as if the description were still being written rather than "this
                is the thing that has already been set up". When automatic backup is on it uses
                border-primary + bg-primary/5 — the repository's existing vocabulary for "this one is
                in use", so no extra element is added. */}
            <div
              className={cn(
                'mt-4 rounded-lg border p-3',
                enabled ? 'border-primary bg-primary/5' : 'border-border',
              )}
            >
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium" title={url}>
                  {shortServer(url)}
                </span>
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium tabular-nums',
                    chip.box,
                  )}
                >
                  {chip.text}
                </span>
              </div>

              {/* The three actions are collapsed into icons + tooltips on the card, matching the "AI
                  providers" service cards. They used to be three text buttons side by side below the
                  card: one solid and two ghost, uneven widths, competing with the card for hierarchy,
                  while they really are "three things you do to this server" and belong to this card. */}
              <div className="mt-1 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
                  {uploading && progress ? t(phaseLabelKeys[progress.phase]) : metaParts.join(' · ')}
                </span>
                <div className="flex shrink-0 items-center gap-0.5">
                  <Tooltip content={running ? t('webdav.backingUp') : t('webdav.backupNow')}>
                    <button
                      type="button"
                      onClick={() => void runBackupNow('manual')}
                      disabled={isBusy}
                      aria-label={running ? t('webdav.backingUp') : t('webdav.backupNow')}
                      className={cardIconButtonClass}
                    >
                      {running
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        : <CloudUpload className="h-3.5 w-3.5" aria-hidden />}
                    </button>
                  </Tooltip>
                  <Tooltip content={t('webdav.restore')}>
                    <button
                      type="button"
                      onClick={() => void handleOpenRestore()}
                      disabled={isBusy}
                      aria-label={t('webdav.restore')}
                      className={cardIconButtonClass}
                    >
                      {busy === 'list' || busy === 'restore'
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                        : <RotateCcw className="h-3.5 w-3.5" aria-hidden />}
                    </button>
                  </Tooltip>
                  <Tooltip content={t('webdav.settings')}>
                    <button
                      type="button"
                      onClick={() => setServerOpen(true)}
                      aria-label={t('webdav.settings')}
                      className={cardIconButtonClass}
                    >
                      <Settings2 className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {uploading && progress && (
                <div
                  className="mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
                  role="progressbar"
                  aria-label={t('webdav.progressAria')}
                  aria-valuenow={Math.round(percent)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <div
                    className="h-full rounded-full bg-primary transition-[width]"
                    style={{ width: `${percent}%` }}
                  />
                </div>
              )}

              {/* The failure reason gets its own line: it can be long, and squeezing it into the summary
                  would push out the information before it. Both success and failure have to be
                  visible — without the failure half, a backup that has been silently failing for
                  months looks exactly like a backup that works. */}
              {!uploading && lastResult && !lastResult.ok && (
                <p className="mt-1.5 text-[11px] text-destructive">
                  {describeWebDavError(lastResult.error ?? '')}
                </p>
              )}

              {actionError && <p className="mt-1.5 text-[11px] text-destructive">{actionError}</p>}
            </div>
          </>
        )}
      </CardContent>

      {serverOpen && (
        <Modal
          title={t('webdav.settingsTitle')}
          onClose={closeServerDialog}
          showCloseButton
          panelClassName="w-[520px]"
        >
          <div className="space-y-4">
            <div>
              <label htmlFor="webdav-url" className="mb-1 block text-sm text-muted-foreground">
                {t('webdav.url')}
              </label>
              <input
                id="webdav-url"
                type="url"
                inputMode="url"
                value={url}
                onChange={(e) => void patch('webdav.url', e.target.value, setUrl)}
                placeholder={DEFAULT_DAV_URL}
                className={inputClass}
              />
              {urlWarning
                ? <FormatHint text={urlWarning} />
                : <p className="mt-1 text-[11px] text-muted-foreground">{t('webdav.urlHint')}</p>}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="webdav-username" className="mb-1 block text-sm text-muted-foreground">
                  {t('webdav.username')}
                </label>
                <input
                  id="webdav-username"
                  type="text"
                  autoComplete="off"
                  value={username}
                  onChange={(e) => void patch('webdav.username', e.target.value, setUsername)}
                  className={inputClass}
                />
              </div>
              <div data-modal-autofocus>
                <label htmlFor="webdav-password" className="mb-1 block text-sm text-muted-foreground">
                  {t('webdav.password')}
                </label>
                <PasswordInput
                  id="webdav-password"
                  label={t('webdav.password')}
                  value={password}
                  onChange={(value) => void patch('webdav.password', value, setPassword)}
                  onSubmit={() => void handleTest()}
                  className={inputClass}
                />
              </div>
            </div>

            {/* Nutstore is the only provider verified so far, and its one sure pitfall (it needs an app password) deserves a line. */}
            <p className="text-[11px] text-muted-foreground">{t('webdav.jianguoyunHint')}</p>
          </div>

          {/* ── Backup content ──
              All three items are listed, and the configuration item is marked "Always included"
              instead of being left out: the question "which files get synced" needs a visible,
              complete answer, not one that has to be inferred from two switches. */}
          <div className="mt-5 border-t border-border pt-4">
            <p className="text-sm font-medium">{t('webdav.contentTitle')}</p>

            <div className="mt-3 flex items-center justify-between gap-3">
              <span className="text-sm">{t('webdav.includeConfig')}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{t('webdav.always')}</span>
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-sm" id="webdav-history-label">{t('webdav.includeHistory')}</label>
              <Switch
                checked={includeHistory}
                labelledBy="webdav-history-label"
                onChange={() => void patch('webdav.includeHistory', !includeHistory, setIncludeHistory)}
                noAnimation={!animate}
              />
            </div>

            <div className="mt-3 flex items-center justify-between gap-3">
              <label className="text-sm" id="webdav-audio-label">{t('webdav.includeAudio')}</label>
              <Switch
                checked={includeAudio}
                labelledBy="webdav-audio-label"
                onChange={() => void patch('webdav.includeAudio', !includeAudio, setIncludeAudio)}
                noAnimation={!animate}
              />
            </div>
            {/* An in-place hint instead of a second-level confirmation dialog: a dialog inside a dialog
                is an anti-pattern, and as long as recordings are on the cost should stay written
                right there rather than disappear after one click. */}
            {includeAudio && <FormatHint text={t('webdav.audioOnHint')} />}
          </div>

          {/* ── Frequency and retention ── */}
          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <label className="text-sm text-muted-foreground">{t('webdav.intervalLabel')}</label>
              <Segmented
                label={t('webdav.intervalLabel')}
                value={intervalHours}
                options={intervalOptions.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                onChange={(value) => void patch('webdav.intervalHours', value, setIntervalHours)}
                className="shrink-0 justify-end"
              />
            </div>
            <div>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <label className="text-sm text-muted-foreground">{t('webdav.keepLabel')}</label>
                <Segmented
                  label={t('webdav.keepLabel')}
                  value={keepCount}
                  options={[3, 5, 10].map((value) => ({ value, label: String(value) }))}
                  onChange={(value) => void patch('webdav.keepCount', value, setKeepCount)}
                  className="shrink-0 justify-end"
                />
              </div>
              {/* "Copies to keep" does not by itself say whether anything gets deleted. Every backup is a
                  new file and never overwrites an old one, so it has to be stated plainly that the
                  excess ones are deleted — the user makes a decision based on this number, so they
                  need to know the cost. */}
              <p className="mt-1 text-[11px] text-muted-foreground">{t('webdav.keepHint')}</p>
            </div>
          </div>

          <div className="mt-5 flex items-center justify-end gap-2">
            {/* The test result and the error share this slot on the left; they never make sense at the same time. */}
            <span className={`min-w-0 flex-1 text-xs ${actionError ? 'text-destructive' : 'text-success-strong'}`}>
              {actionError || testMessage}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="shrink-0 gap-1.5"
              onClick={() => void handleTest()}
              disabled={busy === 'test' || !configured}
            >
              {busy === 'test' && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('webdav.test')}
            </Button>
            <Button size="sm" className="shrink-0" onClick={closeServerDialog}>
              {t('webdav.done')}
            </Button>
          </div>
        </Modal>
      )}

      {restoreList && (
        <Modal title={t('webdav.restoreTitle')} onClose={() => setRestoreList(null)} panelClassName="w-[460px]">
          {restoreList.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('webdav.restoreEmpty')}</p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-y-auto">
              {restoreList.map((entry) => (
                <li key={entry.name}>
                  <button
                    type="button"
                    onClick={() => setRestoreTarget(entry)}
                    className="flex w-full items-center justify-between gap-3 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                  >
                    <span className="min-w-0 truncate">{entry.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(entry.size)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex justify-end">
            <Button variant="outline" size="sm" onClick={() => setRestoreList(null)}>
              {t('common.cancel')}
            </Button>
          </div>
        </Modal>
      )}

      {restoreTarget && (
        <Modal title={t('webdav.restoreConfirmTitle')} onClose={() => setRestoreTarget(null)} showCloseButton={false}>
          <p className="text-sm text-muted-foreground">
            {t('webdav.restoreConfirmBody', { name: restoreTarget.name })}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setRestoreTarget(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={() => void handleRestore()}>
              {t('webdav.restoreConfirmOk')}
            </Button>
          </div>
        </Modal>
      )}

      {restoreDone && (
        <Modal title={t('webdav.restoreDoneTitle')} onClose={() => undefined} locked showCloseButton={false}>
          <p className="text-sm text-muted-foreground">{t('webdav.restoreDoneBody')}</p>
        </Modal>
      )}
    </Card>
  )
}

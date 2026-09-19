/**
 * Update service: metadata check → explicit user action → download → install.
 *
 * Design notes (do not regress these):
 *
 * · **Automatic behavior fetches only the manifest.** Checks run at startup and every
 *   six hours; each is a small JSON GET against the pinned fork manifest. No installer
 *   is ever downloaded automatically, and nothing is ever installed on exit — the old
 *   "exit-path fallback install" is gone. Download + install happen only through
 *   downloadAndInstallUpdate(), one explicit user action.
 *
 * · **The update source is fixed and fork-owned.** updateChecker.ts pins the manifest
 *   URL and validates it fail-closed; the speech-backend setting has no say in where
 *   updates come from.
 *
 * · **No persisted package state.** The old flow stored a pendingUpdate setting and
 *   restored/reinstalled it later; that is gone. Rust authorizes the verified package
 *   in-memory between the download and install IPC calls, and install_downloaded_update
 *   refuses anything this process did not download and verify itself. Startup runs a
 *   one-way legacy migration (clear_legacy_update_artifacts) that drops the old
 *   pendingUpdate key and its temp files.
 *
 * · **The check interval is required, not optional polish.** SayIt lives in the tray
 *   with autostart; many users go weeks without restarting. The six-hour cadence is
 *   what makes an update visible at all. The timer intentionally keeps running while
 *   the app is hidden — it only fetches metadata.
 *
 * Global singleton state: the About page, the sidebar badge, and this service share
 * one store; a single in-flight lock keeps startup checks, manual checks, and user
 * actions from double-running.
 */

import { listen } from '@tauri-apps/api/event'
import { checkVersionUpdate, type VersionInfo } from './updateChecker'
import { getSetting, setSetting } from '@/services/store'
import * as bridge from '@/services/bridge'
import { addRuntimeEvent } from '@/services/debugLog'

/**
 * Periodic check interval. Six hours is the compromise between "every user hears
 * about a release the same day" and "don't hammer the server": the tray-resident app
 * hits it a couple of times per day, and each check is a few-hundred-byte manifest.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/**
 * Current version number.
 *
 * `__APP_VERSION__` is a compile-time constant injected by Vite's define. Guard with
 * typeof instead of reading it directly: a failed injection would throw a
 * ReferenceError inside `void startUpdateService()`, whose Promise swallows it —
 * the symptom would be "updates do nothing at all" with no trace.
 *
 * A missing version must NOT be faked as 0.0.0: every check would then decide "there
 * is an update" and re-download the same package forever. Return null; the caller
 * logs an error and stops checking.
 */
function readCurrentVersion(): string | null {
  const value = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : null
  return value && /^\d+(\.\d+)*$/.test(value) ? value : null
}

/**
 * phase describes what is happening RIGHT NOW, never "is an update available" — that
 * is versionInfo.hasUpdate. There is no 'ready' phase and no pending-package state:
 * "downloaded and waiting" no longer exists in this flow. A former 'ready' phase was
 * a bug farm (periodic checks flipped it to 'checking' and nobody reset it); one
 * thing must have one source of truth, do not add 'ready' back.
 */
export type AutoUpdatePhase = 'idle' | 'checking' | 'downloading' | 'installing'

export interface AutoUpdateState {
  phase: AutoUpdatePhase
  versionInfo?: VersionInfo | null
  checkedAt?: number | null
  error?: string | null
  /** Download progress percent (0-100), from the Rust update-download-progress event */
  downloadPercent?: number
}

let currentState: AutoUpdateState = { phase: 'idle', versionInfo: null, checkedAt: null }
const listeners: Set<(state: AutoUpdateState) => void> = new Set()
/** In-progress check; prevents startup, timer, and manual checks from overlapping */
let checkInFlight: Promise<void> | null = null
/** In-progress explicit download-and-install */
let installInFlight: Promise<void> | null = null
let checkTimer: ReturnType<typeof setInterval> | null = null
/**
 * Bumped every time an explicit install begins. Checks capture it before their fetch
 * and discard the result when it moved — this freezes metadata across the entire
 * install attempt, including the window after a failed download returned the phase
 * to idle, where a phase check alone would let a stale result through.
 */
let installGeneration = 0

// Subscribe to the Rust-side download progress event (explicit downloads only now).
// Never `void` the promise: a rejected listener registration would surface as an
// unhandled rejection with no trace; log it instead (progress UI degrades, updates
// still work — the download itself does not depend on this listener).
void listen<{ downloadedBytes: number; totalBytes: number; percent: number; status: string; error: string | null }>(
  'update-download-progress',
  (event) => {
    const { percent } = event.payload
    setState({ downloadPercent: percent })
  },
).catch((err) => {
  addRuntimeEvent('warn', 'update', 'download progress listener failed to register', { error: String(err) })
})

function setState(patch: Partial<AutoUpdateState>) {
  currentState = { ...currentState, ...patch }
  listeners.forEach((cb) => cb(currentState))
}

export function getAutoUpdateState() {
  return currentState
}

export function onAutoUpdateChange(cb: (state: AutoUpdateState) => void) {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/**
 * Is a newer fork release available according to the last metadata check?
 * Availability is metadata-only: nothing has been downloaded at this point.
 */
export function hasAvailableUpdate(state: AutoUpdateState = currentState): boolean {
  return !!state.versionInfo?.hasUpdate
}

/**
 * One metadata check. All trigger paths (startup, timer, manual button) funnel here.
 *
 * Never downloads: the check either reports an available version or an error, and
 * the user decides what to do with it. A check that starts while an explicit
 * download/install is running is skipped, and a check that STARTED before an install
 * and resolves after it — including after a failed download returned the phase to
 * idle — is discarded via the install generation: replacing versionInfo would let
 * the button act on different metadata than the user saw.
 */
async function runCheck(): Promise<void> {
  if (checkInFlight) { await checkInFlight; return }
  if (currentState.phase === 'downloading' || currentState.phase === 'installing') {
    return
  }

  const current = readCurrentVersion()
  if (!current) {
    // Getting here means the build-time version injection failed and a check is
    // impossible. This must stay loud — a silent return makes "no new version" and
    // "cannot read our own version" indistinguishable from the outside.
    addRuntimeEvent('error', 'update', 'cannot read the app version, update check skipped')
    return
  }

  const generation = installGeneration
  const task = (async () => {
    setState({ phase: 'checking', error: null })
    const info = await checkVersionUpdate(current)

    // Freeze: discard the result when an explicit install began after this check
    // started (the generation moved) or is still running. The generation check also
    // covers a stale check resolving AFTER a failed download reset the phase to idle.
    if (generation !== installGeneration || currentState.phase === 'downloading' || currentState.phase === 'installing') {
      addRuntimeEvent('info', 'update', 'check finished during an explicit install; metadata kept frozen', {
        latest: info.latestVersion,
        hasUpdate: info.hasUpdate,
      })
      return
    }

    setState({ versionInfo: info, checkedAt: Date.now() })

    // Log unconditionally: this is the only way to tell "the check ran and saw
    // nothing" apart from "the check never ran". sourceUrl is what actually served
    // the manifest; it is the pinned fork URL by construction, but keep it in the
    // log so any future channel accident is visible in one line.
    addRuntimeEvent(info.error ? 'warn' : 'info', 'update', 'update check finished', {
      current,
      latest: info.latestVersion,
      hasUpdate: info.hasUpdate,
      error: info.error,
      source: info.sourceUrl,
    })
  })()

  checkInFlight = task
    .catch((err) => {
      addRuntimeEvent('error', 'update', 'update check threw', { error: String(err) })
      setState({ error: String(err) })
    })
    .finally(() => {
      checkInFlight = null
      // Every branch ends here; 'checking' is the only phase this function owns.
      // 'downloading'/'installing' must never be touched: the app may be exiting.
      if (currentState.phase === 'checking') {
        setState({ phase: 'idle' })
      }
    })
  await checkInFlight
}

/** Immediate check plus exactly one six-hour timer. Used by startup and by enabling. */
async function scheduleAutomaticChecks(): Promise<void> {
  await runCheck()
  if (checkTimer === null) {
    checkTimer = setInterval(() => { void runCheck() }, CHECK_INTERVAL_MS)
  }
}

/**
 * Start the update service: legacy migration → read the user's preference →
 * if enabled, check immediately and schedule the periodic metadata checks.
 * Called once from App.tsx on mount.
 */
export async function startUpdateService(): Promise<void> {
  // Wrap the whole function: the caller uses `void startUpdateService()`, so any
  // throw would be silently swallowed and would look like "updates do nothing".
  try {
    const current = readCurrentVersion()
    // First log is unconditional and carries what we believe our version is —
    // troubleshooting starts by checking whether this line exists at all.
    addRuntimeEvent(current ? 'info' : 'error', 'update', 'update service starting', {
      currentVersion: current ?? '(unreadable)',
    })

    // One-way migration first, before anything else and regardless of the user's
    // preference: the pre-fork flow persisted a pending installer and installed it
    // silently on exit. That state must not survive this build, so it is cleaned up
    // even when automatic checks are off. A failure here is logged, never fatal —
    // the app must start.
    await bridge.clearLegacyUpdateArtifacts().catch((err) => {
      addRuntimeEvent('warn', 'update', 'legacy update cleanup failed', { error: String(err) })
    })

    const enabled = await getSetting('autoCheckUpdate', true).catch(() => true)
    if (!enabled) {
      addRuntimeEvent('info', 'update', 'automatic update checks are disabled by the user')
      return
    }
    await scheduleAutomaticChecks()
  } catch (err) {
    addRuntimeEvent('error', 'update', 'update service failed to start', { error: String(err) })
  }
}

/**
 * User preference for automatic metadata checks. Persists FIRST, then moves the
 * scheduler — the stored value is the source of truth.
 *
 * Disabling clears the timer; an already-running metadata request may finish, which
 * is harmless because a check can never install anything. Enabling runs one
 * immediate check and (re)starts at most one timer.
 */
export async function setAutomaticUpdateChecksEnabled(enabled: boolean): Promise<void> {
  await setSetting('autoCheckUpdate', enabled)
  if (!enabled) {
    if (checkTimer !== null) {
      clearInterval(checkTimer)
      checkTimer = null
    }
    addRuntimeEvent('info', 'update', 'automatic update checks disabled by the user')
    return
  }
  addRuntimeEvent('info', 'update', 'automatic update checks enabled by the user')
  await scheduleAutomaticChecks()
}

/**
 * Manual check (the About page button). Works regardless of the automatic-check
 * preference; discovers availability but never downloads.
 */
export async function checkForUpdateNow(): Promise<VersionInfo | null> {
  await runCheck()
  return currentState.versionInfo ?? null
}

/**
 * The user's explicit "download and install": snapshot the currently validated
 * metadata, download via Rust (which re-validates URL/hash and authorizes the
 * package in-memory), then launch the installer. The app closes and relaunches via
 * the watchdog; phase stays 'installing' until that exit.
 *
 * On failure the phase returns to idle with the error set, and versionInfo is kept
 * — the update stays available for another attempt without re-checking.
 */
export async function downloadAndInstallUpdate(): Promise<void> {
  if (installInFlight) { await installInFlight; return }

  const info = currentState.versionInfo
  if (!info?.hasUpdate || !info.latestVersion || !info.downloadUrl || !info.sha512) {
    // The manifest failed validation or the version is current: nothing to install.
    addRuntimeEvent('warn', 'update', 'no validated update is available to install')
    return
  }
  // Destructure into string locals: the guard narrows the fields only up to the
  // async closure below, and TypeScript does not carry property narrowing into it.
  const { latestVersion, downloadUrl, sha512 } = info

  // Bump before any state change: from this point on, check results that were already
  // in flight belong to an older generation and must not touch versionInfo, even if
  // this install fails and the phase returns to idle.
  installGeneration += 1

  const task = (async () => {
    setState({ phase: 'downloading', error: null, downloadPercent: 0 })
    try {
      await bridge.downloadUpdate(downloadUrl, latestVersion, sha512)
      // Only after the Rust side verified the download may the UI show installing.
      setState({ phase: 'installing', downloadPercent: 100 })
      addRuntimeEvent('info', 'update', `version ${latestVersion} downloaded and verified, installing`)
      await bridge.installDownloadedUpdate(latestVersion, sha512)
    } catch (err) {
      // Back to idle with the error; the check metadata stays valid for a retry.
      setState({ phase: 'idle', error: String(err) })
      addRuntimeEvent('error', 'update', 'download and install failed', { error: String(err) })
    }
  })()

  installInFlight = task.finally(() => {
    installInFlight = null
  })
  await installInFlight
}

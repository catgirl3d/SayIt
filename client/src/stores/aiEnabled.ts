// Global state for the AI processing toggle.
// The title bar and the AI processing settings page share it, so a change in either place stays in sync.
// Uses useSyncExternalStore (same pattern as connectionStatus, no external dependencies).

import { getSetting, setSetting } from '@/services/store'
import { setAiEnabledCache, showAiEnabledToast } from '@/services/recorder'
import * as bridge from '@/services/bridge'

type Listener = () => void

let currentValue = false
let initialized = false
let ready = false
/** An explicit set (user or tray) wins over the startup read that may still be in flight. */
let explicitSet = false
const listeners = new Set<Listener>()

function emitChange() {
  for (const listener of listeners) listener()
}

/** Reads the initial value from persisted settings (first call only). Called at app startup. */
export async function initAiEnabled(): Promise<void> {
  if (initialized) return
  initialized = true
  const stored = await getSetting('aiEnabled', false)
  if (!explicitSet) {
    const next = Boolean(stored)
    if (next !== currentValue) {
      currentValue = next
      emitChange()
    }
    // The tray menu reads the database itself when it is built, so it is normally already correct;
    // this alignment is a safety net in case the two defaults ever drift apart again.
    void bridge.setTrayAiEnabled(next)
  }

  // The tray's right-click "AI processing" writes to the database in Rust and broadcasts the result.
  // The listener lives in the store, not in a component: every write path for this state stays in
  // one file, so the recorder cache step cannot be missed. There is no unsubscribe: the store and
  // the webview have the same lifetime.
  //
  // Order matters: listening must start **after** the initial read. The tray menu can be clicked
  // before the frontend loads; with an earlier listener, a broadcast arriving in the window between
  // reading the old value and assigning it would be overwritten by that stale read. Starting after
  // the read means such a click has already been persisted, and the read above sees the new value.
  bridge.onAiCleanupChanged((enabled) => {
    applyExternalAiEnabled(enabled)
  })
  bridge.onAiCleanupToggleRequested(() => {
    void setAiEnabled(!currentValue, { showToast: true })
  })
  // The initial value is settled: set ready on the next frame so the title bar and other subscribers
  // reveal and animate only after the value is stable. This avoids a visible jump from the default
  // (off) to the saved (on) value during cold start.
  const flipReady = () => { if (ready) return; ready = true; emitChange() }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flipReady)
  else flipReady()
}

export function getAiEnabled(): boolean {
  return currentValue
}

/** Whether the initial AI toggle value has been read from settings (lets the UI decide whether to show/animate the first frame). */
export function getAiEnabledReady(): boolean {
  return ready
}

export function subscribeAiEnabled(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Set the toggle: update memory, notify subscribers, persist, and sync the recorder cache
 *  (lightweight; no full IPC refresh). Persistence runs in the background so the UI reacts
 *  immediately and rapid toggles do not stutter. An explicit set also marks the value as ready:
 *  the state is now known even if the initial read has not finished. */
export async function setAiEnabled(next: boolean, options: { showToast?: boolean } = {}): Promise<void> {
  explicitSet = true
  const changed = next !== currentValue
  const becameReady = !ready
  if (changed) currentValue = next
  if (becameReady) ready = true
  if (changed || becameReady) emitChange()
  setAiEnabledCache(next)
  void setSetting('aiEnabled', next)
  // Rebuilding the tray menu is not possible once it exists, so push the state to it.
  void bridge.setTrayAiEnabled(next)
  if (options.showToast) showAiEnabledToast(next)
}

/** Toggle the current value. */
export async function toggleAiEnabled(): Promise<void> {
  await setAiEnabled(!currentValue)
}

/** The state was changed and persisted elsewhere (currently only the tray menu): sync memory,
 *  subscribers, and the recorder cache. Deliberately no database write and no tray write-back:
 *  Rust already did both, and repeating them would create two writers. */
function applyExternalAiEnabled(next: boolean): void {
  explicitSet = true
  const changed = next !== currentValue
  const becameReady = !ready
  if (changed) currentValue = next
  if (becameReady) ready = true
  if (changed || becameReady) emitChange()
  setAiEnabledCache(next)
}

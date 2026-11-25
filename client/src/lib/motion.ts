import { useSyncExternalStore } from 'react'

/**
 * In-app "Interface animations" switch (Settings → Appearance).
 *
 * It turns off the interface motion added for the overlay and shared UI: sliding selection
 * highlights, dialog enter/exit, the success check, the overlay pill width ease and content
 * crossfade, the waveform snapshot, the moving processing bar and breathing warnings. Other
 * animations, such as loading spinners, keep running. The OS reduced-motion preference is
 * deliberately not consulted: this switch is the single control.
 *
 * CSS reads `documentElement[data-motion="off"]` (index.css); JS-driven motion calls
 * `motionAllowed()` or `useMotionAllowed()`. The overlay is a separate React root: it receives the
 * value with every overlay payload (`animationsEnabled`).
 */

/** Window event dispatched whenever the switch changes the document attribute. */
export const MOTION_CHANGE_EVENT = 'sayit-motion-preference-changed'

export function setMotionEnabled(enabled: boolean): void {
  const next = enabled ? 'on' : 'off'
  if (document.documentElement.dataset.motion === next) return
  document.documentElement.dataset.motion = next
  window.dispatchEvent(new Event(MOTION_CHANGE_EVENT))
}

export function motionAllowed(): boolean {
  return document.documentElement.dataset.motion !== 'off'
}

function subscribeMotionPreference(onChange: () => void): () => void {
  window.addEventListener(MOTION_CHANGE_EVENT, onChange)
  return () => window.removeEventListener(MOTION_CHANGE_EVENT, onChange)
}

/** Reactive form of `motionAllowed()`: re-renders when the switch changes. */
export function useMotionAllowed(): boolean {
  return useSyncExternalStore(subscribeMotionPreference, motionAllowed, () => true)
}

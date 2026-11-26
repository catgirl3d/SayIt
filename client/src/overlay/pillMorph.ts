import { useLayoutEffect, useRef, type RefObject } from 'react'
import { motionAllowed } from '@/lib/motion'

/**
 * The pill eases between its shapes instead of hard-cutting.
 *
 * Recording → processing: the pill closes to the 38px circle from both sides over 300 ms
 * (cubic-bezier(0.5, 0, 0.2, 1)). The frozen last recording row keeps its natural width and the
 * shrinking pill clips it from both sides. When processing starts from the waiting circle (a short
 * press) there is nothing to close; the width snaps, which is invisible because the visible
 * surface is already the same 38px circle.
 *
 * Processing → notice: the circle stretches out of the 38px pill over 380 ms. That transition is
 * mask-driven (the surface insets and the content clip in index.css), so this hook does not
 * animate the width: the pill box takes the notice's settled width in one frame while the text is
 * still hidden by the mask and its 100 ms delayed fade-in. This removes the empty-pill phase and
 * keeps truncation stable during the stretch.
 *
 * Notice → notice and other in-show swaps keep the width ease (280 ms,
 * cubic-bezier(0.22, 1, 0.36, 1)). The new text is laid out at its settled width and centred, so
 * the moving pill reveals it from the middle and `truncate` never changes mid-ease.
 *
 * Why animate width rather than transform: the pill is an overflow:hidden rounded container, so
 * scaleX would squash the corners and the text together. A background wider than the pill would
 * mean moving overflow:hidden away — and that is exactly the guard that keeps long text from
 * breaking the rounded corners. This element has only a few dozen nodes and owns a whole window,
 * so the per-frame layout cost is negligible.
 *
 * Morph only within **the same show**: a different presentationId means the window was just
 * shown again, and the pill has its own entrance animation then (overlay-pill-surface-enter);
 * stacking a width animation on top would look wrong. Recording's waiting → listening shares one
 * key because that expansion is handled by the surface insets and the content clip (see
 * overlay-pill-recording-* in index.css); this hook does not interfere with it.
 *
 * The width changes instantly when the in-app Interface animations switch is off (lib/motion.ts);
 * the content still swaps, just without the ease.
 */

const WIDTH_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const WIDTH_DURATION_MS = 280
const CIRCLE_CLOSE_DURATION_MS = 300
const CIRCLE_CLOSE_EASING = 'cubic-bezier(0.5, 0, 0.2, 1)'

type PillContentKind = 'recording' | 'thinking' | 'notice' | null

interface PillWidthEase {
  durationMs: number
  easing: string
}

export interface PillMorphOptions {
  /** Kind of the content rendered now; together with the previous kind it picks the width ease. */
  kind?: PillContentKind
  /** True when the recording being left never reached listening, so its visible shape is a circle. */
  recordingWasPreparing?: boolean
}

function resolveWidthEase(
  previousKind: PillContentKind,
  nextKind: PillContentKind,
  recordingWasPreparing: boolean,
): PillWidthEase | null {
  if (previousKind === 'recording' && nextKind === 'thinking') {
    return recordingWasPreparing
      ? null
      : { durationMs: CIRCLE_CLOSE_DURATION_MS, easing: CIRCLE_CLOSE_EASING }
  }
  if (
    nextKind === 'notice'
    && (previousKind === 'thinking' || (previousKind === 'recording' && recordingWasPreparing))
  ) {
    return null
  }
  return { durationMs: WIDTH_DURATION_MS, easing: WIDTH_EASING }
}

function isAnimating(animation: Animation): boolean {
  return animation.playState === 'running' || animation.playState === 'paused'
}

function animateWidth(el: HTMLElement, from: number, to: number, ease: PillWidthEase): Animation | null {
  if (typeof el.animate !== 'function') return null
  return el.animate(
    [{ width: `${from}px` }, { width: `${to}px` }],
    { duration: ease.durationMs, easing: ease.easing },
  )
}

/**
 * @param morphKey whether the width should morph: only a change triggers the ease. Per-frame
 *   refreshes inside one state (waveform, timer) must produce the same key.
 * @param contentKey whether the content should enter again; defaults to morphKey. They differ only
 *   during recording: a warning or the countdown changes the width (morphKey) but is still the same
 *   recording content (contentKey), so it must not count as a content swap.
 * @returns animateContent — whether the current content was swapped in by a morph (and should
 *   play the content entrance); enteredFrom — the contentKey of the content it replaced (used to
 *   decide whether to fade out the last waveform frame).
 */
export function usePillMorph(
  ref: RefObject<HTMLElement | null>,
  morphKey: string,
  presentationId: number,
  contentKey: string = morphKey,
  options: PillMorphOptions = {},
): { animateContent: boolean; enteredFrom: string | null } {
  const { kind = null, recordingWasPreparing = false } = options
  const committedRef = useRef<{
    key: string | null
    contentKey: string | null
    presentationId: number
    kind: PillContentKind
  }>({
    key: null,
    contentKey: null,
    presentationId,
    kind: null,
  })
  // Natural width while no animation is running. At the moment a morph starts the DOM already
  // shows the new content, so the old width can only come from here.
  const settledWidthRef = useRef<number | null>(null)
  const animationRef = useRef<Animation | null>(null)
  const enteredRef = useRef<{ contentKey: string; from: string } | null>(null)

  // Decide during render (the refs still hold the previous commit's values): contentKey changed
  // and it is still the same show → this new content should enter. The result is remembered by
  // key, so later re-renders inside the same state do not strip the entrance class (stripping it
  // would make the animation jump to its end).
  const committed = committedRef.current
  if (committed.presentationId !== presentationId) {
    enteredRef.current = null
  } else if (committed.contentKey !== null && committed.contentKey !== contentKey) {
    enteredRef.current = { contentKey, from: committed.contentKey }
  }

  useLayoutEffect(() => {
    const el = ref.current
    const prev = committedRef.current
    committedRef.current = {
      key: el ? morphKey : null,
      contentKey: el ? contentKey : null,
      presentationId,
      kind,
    }

    // Interrupt: the content changed again before the previous width ease finished. Continue from
    // the **width currently on screen** instead of jumping back to the start. A finished animation
    // does not count as animating: onfinish is dispatched asynchronously, so the ref may not be
    // cleared yet, and the measured width is then the new content's natural width, which would make
    // this morph look like "the width did not change".
    let fromWidth = settledWidthRef.current
    if (animationRef.current) {
      if (el && isAnimating(animationRef.current)) fromWidth = el.getBoundingClientRect().width
      animationRef.current.cancel()
      animationRef.current = null
    }

    if (!el) {
      settledWidthRef.current = null
      return
    }
    const toWidth = el.getBoundingClientRect().width
    settledWidthRef.current = toWidth
    const widthEase = resolveWidthEase(prev.kind, kind, recordingWasPreparing)

    const shouldMorph = prev.key !== null
      && prev.key !== morphKey
      && prev.presentationId === presentationId
      && fromWidth !== null
      && Math.abs(fromWidth - toWidth) >= 1
      && widthEase !== null
      && motionAllowed()
    if (!shouldMorph || fromWidth === null || widthEase === null) return

    const animation = animateWidth(el, fromWidth, toWidth, widthEase)
    if (!animation) return
    animationRef.current = animation
    const clear = () => {
      if (animationRef.current === animation) animationRef.current = null
    }
    animation.onfinish = clear
    animation.oncancel = clear
  }, [ref, morphKey, contentKey, presentationId, kind, recordingWasPreparing])

  // The width also changes inside one state (a low-volume warning takes away a few waveform bars,
  // the countdown appears), so record the natural width on every commit. It must be declared after
  // the effect above: in the same commit it runs later and does not overwrite the old width first.
  useLayoutEffect(() => {
    if (animationRef.current && isAnimating(animationRef.current)) return
    const el = ref.current
    settledWidthRef.current = el ? el.getBoundingClientRect().width : null
  })

  const entered = enteredRef.current
  const animateContent = entered !== null && entered.contentKey === contentKey
  return { animateContent, enteredFrom: animateContent && entered ? entered.from : null }
}

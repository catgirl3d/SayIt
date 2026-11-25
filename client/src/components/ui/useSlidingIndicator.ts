import { useLayoutEffect, useRef, type RefObject } from 'react'

/**
 * One "selected background" that slides between options instead of the old cell fading out and
 * the new one changing color (radio pills / History filter / sidebar).
 *
 * Usage: container `position: relative`, one `<span ref={indicatorRef} className="sliding-indicator ..." />`
 * inside (last, in a `space-y-*` container, otherwise it adds margin-top to the first real option),
 * options draw no selected background of their own and sit above it with `position: relative`.
 * The active option is found by `activeSelector` (default `[aria-checked="true"]`; the sidebar uses
 * NavLink's own `[aria-current="page"]`).
 *
 * Position is written **directly to the DOM, not through state**: state would add a render, and
 * measuring has to happen after layout anyway; going through setState would only paint the first
 * frame in the wrong place.
 *
 * Three cases **must not slide**, only appear in place:
 *  1. First placement (sliding from 0,0 on mount looks like the setting changed itself);
 *  2. there was no visible selected item before (container display:none, or the sidebar's active
 *     item moved to another group);
 *  3. the caller says animation is not allowed right now (settings just loaded asynchronously,
 *     `animated=false`).
 * Window resize / font-load shifts don't slide either: the ResizeObserver puts the indicator there
 * directly.
 */
export function useSlidingIndicator(
  containerRef: RefObject<HTMLElement | null>,
  activeKey: unknown,
  options: { animated?: boolean; activeSelector?: string } = {},
): RefObject<HTMLSpanElement> {
  const { animated = true, activeSelector = '[aria-checked="true"]' } = options
  const indicatorRef = useRef<HTMLSpanElement>(null)
  const placedRef = useRef(false)
  const fadedOutRef = useRef(false)
  const geomRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null)
  const animatedRef = useRef(animated)
  animatedRef.current = animated

  useLayoutEffect(() => {
    const container = containerRef.current
    const indicator = indicatorRef.current
    if (!container || !indicator) return

    const place = (allowSlide: boolean) => {
      const target = container.querySelector<HTMLElement>(activeSelector)
      if (!target || target.offsetWidth === 0) {
        if (placedRef.current) fadedOutRef.current = true
        indicator.style.opacity = '0'
        placedRef.current = false
        geomRef.current = null
        return
      }
      const { x, y } = offsetWithin(target, container)
      const geom = { x, y, w: target.offsetWidth, h: target.offsetHeight }
      const last = geomRef.current
      // ResizeObserver always calls back once on observe(), even when nothing changed. Treating
      // that one as "the size changed, snap it over" would cut the just-started slide short
      // (measured: the indicator did not move a single cell). Only touch it when geometry really
      // changed.
      if (!allowSlide && last && last.x === geom.x && last.y === geom.y && last.w === geom.w && last.h === geom.h) return
      geomRef.current = geom

      const slide = allowSlide && placedRef.current && animatedRef.current
      // Coming back from "this group has no selected item" (sidebar groups): don't slide, but fade
      // in, otherwise it looks like the indicator popped out of nowhere.
      const fadeIn = !placedRef.current && fadedOutRef.current && animatedRef.current
      indicator.style.transition = slide ? '' : 'none'
      indicator.style.width = `${geom.w}px`
      indicator.style.height = `${geom.h}px`
      indicator.style.transform = `translate(${geom.x}px, ${geom.y}px)`
      if (!fadeIn) indicator.style.opacity = '1'
      if (!slide) {
        // Let the "no transition" position take effect, then put the transition back; without
        // reading layout once the browser merges both writes into a single slide.
        void indicator.offsetWidth
        indicator.style.transition = ''
        if (fadeIn) indicator.style.opacity = '1'
      }
      placedRef.current = true
      fadedOutRef.current = false
    }

    place(true)

    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => place(false))
    // Watch children too: when the interface language changes, option text gets wider while the
    // full-width container itself may not change size at all.
    observer.observe(container)
    for (const child of Array.from(container.children)) {
      if (child !== indicator) observer.observe(child)
    }
    return () => observer.disconnect()
  }, [containerRef, activeKey, activeSelector])

  return indicatorRef
}

/**
 * Position of the selected item relative to the container's padding box. Uses offset* accumulated
 * up the chain instead of getBoundingClientRect: an entering dialog scales the whole panel, so rect
 * reports the scaled-down size and the indicator stops a few pixels off (transforms do not trigger
 * ResizeObserver, so it would never be corrected later). offset* is not affected by transforms.
 * Only a positioned wrapper becomes offsetParent (a Tooltip wrapper is one only when it carries
 * position: relative), so every hop in the chain is added. The container itself must be
 * position: relative, otherwise the chain never reaches it and the container-relative rect fallback
 * below runs.
 */
function offsetWithin(el: HTMLElement, container: HTMLElement): { x: number; y: number } {
  let x = 0
  let y = 0
  let node: HTMLElement | null = el
  while (node && node !== container) {
    x += node.offsetLeft
    y += node.offsetTop
    const parent = node.offsetParent as HTMLElement | null
    if (parent && parent !== container) {
      x += parent.clientLeft
      y += parent.clientTop
    }
    node = parent
  }
  if (node === container) return { x, y }
  // The container is not on the offsetParent chain (it is missing `position: relative`): fall
  // back to container-relative rectangles.
  const er = el.getBoundingClientRect()
  const cr = container.getBoundingClientRect()
  return { x: er.left - cr.left - container.clientLeft, y: er.top - cr.top - container.clientTop }
}

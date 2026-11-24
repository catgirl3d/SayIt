// Shared popover primitive: anchored placement, outside-click dismissal and Escape routing.
//
// The caller owns `open`; the hook only reports a placement and asks for dismissal through
// onDismiss, so the same primitive can back an inline panel and a body portal.
//
// Two placement modes share the dismissal and focus logic. Card mode measures the panel and places
// it beside the anchor; ColorPopover and ModelLanguageBadge use it. List mode (`kind: 'list'`) places
// the list from the anchor alone, caps its height, and lets the caller mount the panel only once
// `positioned` is true; ModelPicker uses it.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import {
  placeCard,
  placeList,
  type ListPlacement,
  type ListPlacementOptions,
  type PlacementOptions,
} from '@/lib/popoverPlacement'

/** Card placement options keep their old shape; list placement is tagged with `kind: 'list'`. */
export type PopoverPlacement = PlacementOptions | ({ kind: 'list' } & ListPlacementOptions)

export interface UsePopoverOptions {
  /** Controlled by the caller. Listeners and the placement exist only while this is true. */
  open: boolean
  /** Asked to close on an outside mousedown and on Escape. */
  onDismiss: () => void
  /** Element the panel is placed against. */
  anchorRef: RefObject<HTMLElement | null>
  /** Element whose mousedown is not "outside"; defaults to anchorRef. */
  triggerRef?: RefObject<HTMLElement | null>
  /** Focused after an Escape dismissal; nothing is focused by default. */
  returnFocusRef?: RefObject<HTMLElement | null>
  placement?: PopoverPlacement
}

export interface PanelStyle {
  top?: number
  bottom?: number
  left: number
  width?: number
  maxHeight?: number
}

/** Hidden until the first measurement, so the panel never flashes at the window origin. */
const HIDDEN: PanelStyle = { top: -9999, left: -9999 }

type PanelPosition = { top: number; left: number } | ListPlacement

function isListPlacement(
  placement: PopoverPlacement | undefined,
): placement is { kind: 'list' } & ListPlacementOptions {
  return placement !== undefined && 'kind' in placement && placement.kind === 'list'
}

// Open popovers, bottom to top. Every popover listens on window capture, and stopPropagation does
// not keep another listener on the same node from running, so with two nested popovers a single
// Escape would dismiss both. Each listener therefore checks that its own layer is topmost. This is
// the same pattern as openModals in components/ui/modal.tsx.
const layers: symbol[] = []

export function usePopover(options: UsePopoverOptions): {
  panelRef: RefObject<HTMLDivElement>
  panelStyle: PanelStyle
  positioned: boolean
} {
  const { open } = options
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<PanelPosition | null>(null)
  const stackToken = useRef(Symbol('popover')).current

  // The latest options are read from a ref, so a caller passing a fresh onDismiss (the normal
  // inline arrow) does not remove and re-add every listener on each render. Modal documents the
  // same pitfall around requestClose.
  const latest = useRef(options)
  latest.current = options

  const measure = useCallback(() => {
    const anchor = latest.current.anchorRef.current
    if (!anchor) return
    const anchorRect = anchor.getBoundingClientRect()
    const placement = latest.current.placement
    // List mode needs no panel: the caller mounts it only after this measurement succeeds.
    if (isListPlacement(placement)) {
      setPos(placeList(anchorRect, { height: window.innerHeight }, placement))
      return
    }
    const panel = panelRef.current
    if (!panel) return
    const panelRect = panel.getBoundingClientRect()
    setPos(
      placeCard(
        { top: anchorRect.top, bottom: anchorRect.bottom, left: anchorRect.left, width: anchorRect.width },
        { width: panelRect.width, height: panelRect.height },
        { width: window.innerWidth, height: window.innerHeight },
        placement,
      ),
    )
  }, [])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    measure()
  }, [open, measure])

  // Keep the panel glued to the anchor while the layout moves. Scroll is captured because the
  // settings page scrolls inside <main>, not the window. Scrolls whose target is inside the panel
  // are its own internal list: re-measuring there would reposition the panel on every wheel tick
  // while the user browses it. A scroll target may be the window rather than a Node, which counts as
  // outside (and `contains` would throw on it).
  useEffect(() => {
    if (!open) return
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && panelRef.current?.contains(event.target)) return
      measure()
    }
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', onScroll, true)
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      // Card mode tracks the panel, whose size follows its content. List mode tracks the anchor: the
      // field grows when chips wrap, and the panel exists only after the first measurement.
      const target = isListPlacement(latest.current.placement) ? latest.current.anchorRef.current : panelRef.current
      if (target) {
        observer = new ResizeObserver(() => measure())
        observer.observe(target)
      }
    }
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', onScroll, true)
      observer?.disconnect()
    }
  }, [open, measure])

  // A press inside the panel or on the trigger that opened it is not "outside". The trigger can be
  // a separate control (ModelPicker's chevron) rather than the anchor box.
  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null
      if (panelRef.current?.contains(target)) return
      const { anchorRef, triggerRef } = latest.current
      if ((triggerRef ?? anchorRef).current?.contains(target)) return
      latest.current.onDismiss()
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  // Escape is consumed on window capture, before the Modal's document-capture listener, otherwise
  // the whole dialog would close together with the popover inside it. ModelPicker and Select
  // already rely on this ordering. Only Escape is touched: every other key passes through.
  useEffect(() => {
    if (!open) return
    layers.push(stackToken)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (layers[layers.length - 1] !== stackToken) return
      event.stopPropagation()
      event.preventDefault()
      const { onDismiss, returnFocusRef } = latest.current
      onDismiss()
      returnFocusRef?.current?.focus()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      const index = layers.indexOf(stackToken)
      if (index !== -1) layers.splice(index, 1)
    }
  }, [open, stackToken])

  return { panelRef, panelStyle: pos ?? HIDDEN, positioned: pos !== null }
}

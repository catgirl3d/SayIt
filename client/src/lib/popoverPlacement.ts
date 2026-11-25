// Placement for anchored popover panels.
//
// Extracted from the hand-rolled copies in ColorPopover and ModelLanguageBadge, which computed
// the same flip-and-clamp arithmetic with different defaults. The rules are kept literal so the
// existing surfaces keep their exact placement; popoverPlacement.test.ts pins parity against the
// old formulas.
//
// placeList covers the other placement family: a list whose position comes from the anchor alone
// and whose height is capped, as the model picker used to compute by hand.

export interface PlacementOptions {
  /** Horizontal alignment against the anchor: its left edge, or centered over it. Defaults to 'start'. */
  align?: 'start' | 'center'
  /** Distance between the anchor and the panel. Defaults to 8. */
  gap?: number
  /** Free space kept between the panel and each viewport edge. Defaults to 8. */
  viewportMargin?: number
}

export function placeCard(
  anchor: { top: number; bottom: number; left: number; width: number },
  panel: { width: number; height: number },
  viewport: { width: number; height: number },
  options: PlacementOptions = {},
): { top: number; left: number } {
  const gap = options.gap ?? 8
  const margin = options.viewportMargin ?? 8

  let top = anchor.bottom + gap
  if (top + panel.height > viewport.height - margin) {
    top = anchor.top - panel.height - gap
  }
  // The inner max() keeps the upper clamp from moving a panel taller than the free area above
  // the window: such a panel starts at the margin instead.
  top = Math.min(Math.max(top, margin), Math.max(margin, viewport.height - panel.height - margin))

  let left = options.align === 'center' ? anchor.left + anchor.width / 2 - panel.width / 2 : anchor.left
  if (left + panel.width > viewport.width - margin) {
    left = viewport.width - panel.width - margin
  }
  if (left < margin) {
    left = margin
  }

  return { top, left }
}

export interface ListPlacementOptions {
  /** Distance between the anchor and the list. Defaults to 4. */
  gap?: number
  /** Free space kept between the list and each viewport edge. Defaults to 8. */
  viewportMargin?: number
  /** Room below the anchor under which the list considers opening upward. */
  preferredSpace: number
  /** Cap of the list height. */
  maxHeight: number
  /** Floor of the list height. Defaults to 120. */
  minHeight?: number
}

export interface ListPlacement {
  top?: number
  bottom?: number
  left: number
  width: number
  maxHeight: number
}

/**
 * Places a list against an anchor without measuring the list itself. The list opens below unless
 * the room below is under preferredSpace and the room above is larger, and its height is capped to
 * the free space on that side (between the floor and the cap).
 */
export function placeList(
  anchor: { top: number; bottom: number; left: number; width: number },
  viewport: { height: number },
  options: ListPlacementOptions,
): ListPlacement {
  const gap = options.gap ?? 4
  const margin = options.viewportMargin ?? 8
  const minHeight = options.minHeight ?? 120

  // Not reduced by the gap: the old ModelPicker counted it the same way, and parity matters here.
  const spaceBelow = viewport.height - anchor.bottom - margin
  const spaceAbove = anchor.top - margin
  const openUp = spaceBelow < options.preferredSpace && spaceAbove > spaceBelow
  const maxHeight = Math.min(options.maxHeight, Math.max(minHeight, openUp ? spaceAbove : spaceBelow))

  return {
    top: openUp ? undefined : anchor.bottom + gap,
    bottom: openUp ? viewport.height - anchor.top + gap : undefined,
    left: anchor.left,
    width: anchor.width,
    maxHeight,
  }
}

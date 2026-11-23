// Placement for anchored popover panels.
//
// Extracted from the hand-rolled copies in ColorPopover and ModelLanguageBadge, which computed
// the same flip-and-clamp arithmetic with different defaults. The rules are kept literal so the
// existing surfaces keep their exact placement; popoverPlacement.test.ts pins parity against the
// old formulas.

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

import { describe, expect, it } from 'vitest'
import { placeCard, type PlacementOptions } from '../popoverPlacement'

interface Anchor {
  top: number
  bottom: number
  left: number
  width: number
}

interface Size {
  width: number
  height: number
}

const viewport: Size = { width: 800, height: 600 }

const rect = (top: number, left: number, width: number, height = 36): Anchor => ({
  top,
  bottom: top + height,
  left,
  width,
})

describe('placeCard', () => {
  it('opens below the anchor when the panel fits', () => {
    expect(placeCard(rect(100, 40, 24), { width: 224, height: 250 }, viewport)).toEqual({ top: 144, left: 40 })
  })

  it('flips above the anchor when there is no room below', () => {
    expect(placeCard(rect(400, 40, 24), { width: 224, height: 250 }, viewport)).toEqual({ top: 142, left: 40 })
  })

  it('keeps a flipped panel inside the window when the anchor lies below it', () => {
    // Flipped top is 700 - 250 - 8 = 442; the clamp moves it up to 600 - 250 - 8 = 342.
    expect(placeCard(rect(700, 40, 24), { width: 224, height: 250 }, viewport)).toEqual({ top: 342, left: 40 })
  })

  it('keeps the panel inside the window when neither side has room for it', () => {
    // Below: 136 + 8 + 500 overflows; above: 100 - 500 - 8 is negative, so the margin wins.
    expect(placeCard(rect(100, 40, 24), { width: 224, height: 500 }, viewport)).toEqual({ top: 8, left: 40 })

    // A panel taller than the free area still starts at the margin and stays inside the window.
    expect(placeCard(rect(250, 40, 24), { width: 224, height: 590 }, viewport)).toEqual({ top: 8, left: 40 })
    expect(8 + 590).toBeLessThanOrEqual(viewport.height)
  })

  it('aligns to the anchor start by default and centers over it on request', () => {
    const anchor = rect(100, 300, 36)
    const panel = { width: 224, height: 250 }

    expect(placeCard(anchor, panel, viewport)).toEqual(placeCard(anchor, panel, viewport, { align: 'start' }))
    expect(placeCard(anchor, panel, viewport, { align: 'start' })).toEqual({ top: 144, left: 300 })
    expect(placeCard(anchor, panel, viewport, { align: 'center' })).toEqual({ top: 144, left: 206 })
  })

  it('clamps to the left window edge', () => {
    const anchor = rect(100, 0, 24)

    expect(placeCard(anchor, { width: 224, height: 250 }, viewport, { align: 'center' }).left).toBe(8)
    expect(placeCard(anchor, { width: 224, height: 250 }, viewport, { align: 'start' }).left).toBe(8)
  })

  it('clamps to the right window edge for both alignments', () => {
    const anchor = rect(100, 780, 24)
    const panel = { width: 224, height: 250 }

    expect(placeCard(anchor, panel, viewport, { align: 'start' }).left).toBe(568)
    expect(placeCard(anchor, panel, viewport, { align: 'center' }).left).toBe(568)
  })

  it('uses custom gap and viewport margin values', () => {
    const panel = { width: 224, height: 250 }
    const options: PlacementOptions = { gap: 20, viewportMargin: 40 }

    expect(placeCard(rect(300, 100, 24), panel, viewport, options)).toEqual({ top: 40, left: 100 })
    expect(placeCard(rect(300, 0, 24), panel, viewport, options)).toEqual({ top: 40, left: 40 })
  })
})

// The placement of the two existing popovers, copied verbatim from ModelLanguageBadge (gap 6,
// margin 10, start alignment) and ColorPopover (gap 8, margin 8, center alignment). placeCard has
// to reproduce them on the whole grid for the later migration to be behavior-preserving.
function badgeReference(anchor: Anchor, panel: Size, view: Size): { top: number; left: number } {
  const ph = panel.height
  let top = anchor.bottom + 6
  let left = anchor.left
  if (top + ph > view.height - 10) top = anchor.top - ph - 6
  const maxTop = Math.max(10, view.height - ph - 10)
  top = Math.min(Math.max(top, 10), maxTop)
  if (left + panel.width > view.width - 10) left = view.width - panel.width - 10
  if (left < 10) left = 10
  return { top, left }
}

function colorReference(anchor: Anchor, panel: Size, view: Size): { top: number; left: number } {
  const ph = panel.height
  const pw = panel.width
  let top = anchor.bottom + 8
  if (top + ph > view.height - 8) top = Math.max(8, anchor.top - ph - 8)
  const left = Math.min(Math.max(8, anchor.left + anchor.width / 2 - pw / 2), view.width - pw - 8)
  return { top, left }
}

function anchorGrid(view: Size): Anchor[] {
  const tops = [0, 12, 100, Math.round(view.height / 2), view.height - 48, view.height - 36]
  const lefts = [0, 8, 120, Math.round(view.width / 2), view.width - 60, view.width - 36]
  const anchors: Anchor[] = []
  for (const top of tops) {
    for (const left of lefts) {
      for (const width of [24, 36]) anchors.push(rect(top, left, width))
    }
  }
  return anchors
}

// Anchors scrolled out of the window, above and below it. Only the ModelLanguageBadge parity covers
// them: that formula clamped such anchors, while the old ColorPopover never did and the unified
// clamp intentionally differs from it there.
function outsideAnchorGrid(view: Size): Anchor[] {
  const anchors: Anchor[] = []
  for (const top of [-60, view.height + 60]) {
    for (const left of [0, 120, view.width - 60]) {
      for (const width of [24, 36]) anchors.push(rect(top, left, width))
    }
  }
  return anchors
}

const viewports: Size[] = [
  { width: 800, height: 600 },
  { width: 1120, height: 768 },
  { width: 1400, height: 900 },
]

const panels: Size[] = [
  { width: 224, height: 250 },
  { width: 384, height: 300 },
  { width: 100, height: 40 },
]

describe('placeCard parity with the old popover formulas', () => {
  it('matches the ModelLanguageBadge formula for every anchor, panel and viewport', () => {
    let cases = 0
    for (const view of viewports) {
      for (const panel of panels) {
        for (const anchor of [...anchorGrid(view), ...outsideAnchorGrid(view)]) {
          const label = `anchor ${JSON.stringify(anchor)}, panel ${panel.width}x${panel.height}, viewport ${view.width}x${view.height}`
          expect(placeCard(anchor, panel, view, { align: 'start', gap: 6, viewportMargin: 10 }), label).toEqual(
            badgeReference(anchor, panel, view),
          )
          cases += 1
        }
      }
    }
    expect(cases).toBeGreaterThan(0)
  })

  it('matches the ColorPopover formula where the panel fits inside the viewport margins', () => {
    let cases = 0
    for (const view of viewports) {
      for (const panel of panels) {
        // Oversized panels are excluded on purpose: the shared clamp intentionally differs there.
        // The same holds for anchors outside the viewport, so outsideAnchorGrid is not used here.
        if (panel.height > view.height - 2 * 8 || panel.width > view.width - 2 * 8) continue
        for (const anchor of anchorGrid(view)) {
          const label = `anchor ${JSON.stringify(anchor)}, panel ${panel.width}x${panel.height}, viewport ${view.width}x${view.height}`
          expect(placeCard(anchor, panel, view, { align: 'center', gap: 8, viewportMargin: 8 }), label).toEqual(
            colorReference(anchor, panel, view),
          )
          cases += 1
        }
      }
    }
    expect(cases).toBeGreaterThan(0)
  })
})

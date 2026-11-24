import { describe, expect, it } from 'vitest'
import {
  placeCard,
  placeList,
  type ListPlacement,
  type ListPlacementOptions,
  type PlacementOptions,
} from '../popoverPlacement'

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

const LIST_OPTIONS: ListPlacementOptions = { preferredSpace: 320, maxHeight: 360 }

describe('placeList', () => {
  it('opens below the anchor when the room below is comfortable', () => {
    expect(placeList(rect(100, 40, 300), { height: 900 }, LIST_OPTIONS)).toEqual({
      top: 140,
      bottom: undefined,
      left: 40,
      width: 300,
      maxHeight: 360,
    })
  })

  it('opens above by its bottom edge when the room below is tight and above has more', () => {
    expect(placeList(rect(640, 40, 300), { height: 900 }, LIST_OPTIONS)).toEqual({
      top: undefined,
      bottom: 264,
      left: 40,
      width: 300,
      maxHeight: 360,
    })
  })

  it('stays below when above has even less room', () => {
    // Below 96, above 52: the larger side wins even though it is under preferredSpace.
    expect(placeList(rect(60, 10, 300), { height: 200 }, LIST_OPTIONS)).toEqual({
      top: 100,
      bottom: undefined,
      left: 10,
      width: 300,
      maxHeight: 120,
    })
  })

  it('stays below when the room below equals the preferred space exactly', () => {
    // Below 900 - 572 - 8 = 320, which is not under preferredSpace; above would be 528.
    expect(placeList(rect(536, 40, 300), { height: 900 }, LIST_OPTIONS)).toEqual({
      top: 576,
      bottom: undefined,
      left: 40,
      width: 300,
      maxHeight: 320,
    })
  })

  it('stays below when above has exactly as much room as below', () => {
    // Below 400 - 218 - 8 = 174 and above 182 - 8 = 174: a tie is not "larger", so the list stays below.
    expect(placeList(rect(182, 40, 300), { height: 400 }, LIST_OPTIONS)).toEqual({
      top: 222,
      bottom: undefined,
      left: 40,
      width: 300,
      maxHeight: 174,
    })
  })

  it('keeps the minimum height when neither side has room', () => {
    // Below 76, above 12: flipping does not help, and the floor keeps the list usable.
    expect(placeList(rect(20, 10, 300), { height: 140 }, LIST_OPTIONS)).toEqual({
      top: 60,
      bottom: undefined,
      left: 10,
      width: 300,
      maxHeight: 120,
    })
  })

  it('never grows past the height cap', () => {
    const placed = placeList(rect(100, 40, 300), { height: 900 }, { preferredSpace: 320, maxHeight: 200 })
    expect(placed.maxHeight).toBe(200)
  })

  it('uses custom gap and viewport margin values', () => {
    const options: ListPlacementOptions = { preferredSpace: 320, maxHeight: 360, gap: 20, viewportMargin: 40 }

    // Below 900 - 336 - 40 = 524: the list opens below with the custom gap.
    expect(placeList(rect(300, 100, 300), { height: 900 }, options)).toEqual({
      top: 356,
      bottom: undefined,
      left: 100,
      width: 300,
      maxHeight: 360,
    })
    // Below 24, above 260: the bigger margin flips this one above.
    expect(placeList(rect(300, 100, 300), { height: 400 }, options)).toEqual({
      top: undefined,
      bottom: 120,
      left: 100,
      width: 300,
      maxHeight: 260,
    })
  })

  it('takes the left edge and width from the anchor', () => {
    expect(placeList(rect(100, 300, 480), { height: 700 }, LIST_OPTIONS)).toMatchObject({ left: 300, width: 480 })
  })
})

// The arithmetic of the old ModelPicker.updatePosition (gap 4, margin 8, preferred 320, cap 360,
// floor 120), copied verbatim. placeList has to reproduce it on the whole grid.
function listReference(anchor: Anchor, vh: number): ListPlacement {
  const spaceBelow = vh - anchor.bottom - 8
  const spaceAbove = anchor.top - 8
  const openUpwards = spaceBelow < 320 && spaceAbove > spaceBelow
  const maxHeight = Math.min(360, Math.max(120, openUpwards ? spaceAbove : spaceBelow))
  return {
    top: openUpwards ? undefined : anchor.bottom + 4,
    bottom: openUpwards ? vh - anchor.top + 4 : undefined,
    left: anchor.left,
    width: anchor.width,
    maxHeight,
  }
}

describe('placeList parity with the old ModelPicker formula', () => {
  it('matches the old updatePosition result for every anchor, window height, left edge and width', () => {
    let cases = 0
    for (const height of [200, 420, 700, 900]) {
      const tops = [-40, 0, 60, 100, 300, 460, 500, 640, height - 36, height + 40]
      for (const top of tops) {
        for (const left of [10, 300]) {
          for (const width of [300, 480]) {
            const anchor = rect(top, left, width)
            const label = `anchor ${JSON.stringify(anchor)}, viewport height ${height}`
            expect(placeList(anchor, { height }, LIST_OPTIONS), label).toEqual(listReference(anchor, height))
            cases += 1
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(0)
  })
})

const SELECT_LIST_OPTIONS: ListPlacementOptions = { preferredSpace: 180, maxHeight: 240 }

// The arithmetic of the old Select.updatePosition (gap 4, margin 8, preferred 180, cap 240, floor
// 120), copied verbatim. The old code placed an upward list by its top edge, assuming the full cap;
// placeList pins it by the bottom edge instead, so the parity is geometric rather than literal.
function selectReference(anchor: Anchor, vh: number): { openUpwards: boolean; top: number; maxHeight: number } {
  const spaceBelow = vh - anchor.bottom - 8
  const spaceAbove = anchor.top - 8
  const openUpwards = spaceBelow < 180 && spaceAbove > spaceBelow
  const maxHeight = Math.min(240, Math.max(120, openUpwards ? spaceAbove : spaceBelow))
  const top = openUpwards ? anchor.top - maxHeight - 4 : anchor.bottom + 4
  return { openUpwards, top, maxHeight }
}

describe('placeList parity with the old Select formula', () => {
  it('matches the old updatePosition result for every anchor, window height, left edge and width', () => {
    let cases = 0
    for (const height of [200, 420, 700, 900]) {
      const tops = [-40, 0, 60, 100, 300, 460, 500, 640, height - 36, height + 40]
      for (const top of tops) {
        for (const left of [10, 300]) {
          for (const width of [300, 480]) {
            const anchor = rect(top, left, width)
            const label = `anchor ${JSON.stringify(anchor)}, viewport height ${height}`
            const placed = placeList(anchor, { height }, SELECT_LIST_OPTIONS)
            const reference = selectReference(anchor, height)
            const openUpwards = placed.top === undefined

            expect(placed.maxHeight, label).toBe(reference.maxHeight)
            expect(placed.left, label).toBe(anchor.left)
            expect(placed.width, label).toBe(anchor.width)
            expect(openUpwards, label).toBe(reference.openUpwards)
            if (openUpwards) {
              expect(placed.top, label).toBeUndefined()
              // A full-height list occupies exactly the old top-anchored rectangle.
              expect(height - (placed.bottom as number) - placed.maxHeight, label).toBe(reference.top)
            } else {
              expect(placed.bottom, label).toBeUndefined()
              expect(placed.top, label).toBe(reference.top)
            }
            cases += 1
          }
        }
      }
    }
    expect(cases).toBeGreaterThan(0)
  })
})

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

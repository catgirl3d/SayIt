// @vitest-environment jsdom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setLocale, t } from '@/i18n'
import { DEFAULT_CUSTOM_WAVE, type CustomWaveColors } from '@/lib/overlayWaveColors'
import { CustomWaveEditor } from '../CustomWaveEditor'
import { ModelLanguageBadge } from '../ModelLanguageBadge'

interface Box {
  top: number
  left: number
  width: number
  height: number
}

function toRect(box: Box): DOMRect {
  return {
    x: box.left,
    y: box.top,
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    right: box.left + box.width,
    bottom: box.top + box.height,
    toJSON: () => ({}),
  } as DOMRect
}

/**
 * jsdom has no layout: the popover panel (role dialog) and its trigger (aria-haspopup dialog) get fixed
 * boxes, every other element measures as empty.
 */
function mockLayout(trigger: Box, panel: { width: number; height: number }) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') === 'dialog') {
      return toRect({ top: 0, left: 0, width: panel.width, height: panel.height })
    }
    if (this.getAttribute('aria-haspopup') === 'dialog') return toRect(trigger)
    return toRect({ top: 0, left: 0, width: 0, height: 0 })
  })
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
}

function ColorHost() {
  const [value, setValue] = useState<CustomWaveColors>({
    mode: 'solid',
    from: '#ff6b35',
    to: DEFAULT_CUSTOM_WAVE.to,
  })
  return <CustomWaveEditor value={value} animate={false} onChange={setValue} />
}

const originalWidth = window.innerWidth
const originalHeight = window.innerHeight

beforeEach(() => {
  setLocale('en')
  setViewport(1000, 800)
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  setLocale('en')
  setViewport(originalWidth, originalHeight)
})

describe('popover placement wiring', () => {
  it('uses the badge placement constants', () => {
    mockLayout({ top: 100, left: 40, width: 60, height: 20 }, { width: 320, height: 200 })
    render(
      <ModelLanguageBadge
        model={{ id: 'multi', name: 'Multilingual', languages: ['en', 'uk', 'ru', 'zh'] }}
        badgeLanguage="en"
      />,
    )

    const label = t('local.languagesTitle', { count: 4 })
    fireEvent.click(screen.getByRole('button', { name: label }))

    const panel = screen.getByRole('dialog', { name: label })
    expect(panel.style.top).toBe('126px')
    expect(panel.style.left).toBe('40px')
  })

  it('uses the color picker placement constants', () => {
    mockLayout({ top: 100, left: 300, width: 20, height: 20 }, { width: 224, height: 250 })
    render(<ColorHost />)

    fireEvent.click(screen.getByRole('button', { name: 'Color' }))

    const panel = screen.getByRole('dialog', { name: 'Color' })
    expect(panel.style.top).toBe('128px')
    expect(panel.style.left).toBe('198px')
  })

  it('clamps the badge panel to the right window edge using the badge margin', () => {
    mockLayout({ top: 100, left: 900, width: 60, height: 20 }, { width: 320, height: 200 })
    render(
      <ModelLanguageBadge
        model={{ id: 'multi', name: 'Multilingual', languages: ['en', 'uk', 'ru', 'zh'] }}
        badgeLanguage="en"
      />,
    )

    const label = t('local.languagesTitle', { count: 4 })
    fireEvent.click(screen.getByRole('button', { name: label }))

    // 1000 - 320 - 10 = 670
    const panel = screen.getByRole('dialog', { name: label })
    expect(panel.style.top).toBe('126px')
    expect(panel.style.left).toBe('670px')
  })

  it('clamps the color picker panel to the right window edge using its margin', () => {
    mockLayout({ top: 100, left: 990, width: 20, height: 20 }, { width: 224, height: 250 })
    render(<ColorHost />)

    fireEvent.click(screen.getByRole('button', { name: 'Color' }))

    // 1000 - 224 - 8 = 768
    const panel = screen.getByRole('dialog', { name: 'Color' })
    expect(panel.style.top).toBe('128px')
    expect(panel.style.left).toBe('768px')
  })
})

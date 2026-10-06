import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as OverlayModule from '../Overlay'

interface CaptionProps {
  text: string
  status: string
  error: string
}

describe('translated subtitle markup', () => {
  it.each([
    { text: 'Translated <speech>', status: 'Listening to computer audio', error: '', visible: 'Translated &lt;speech&gt;' },
    { text: '', status: 'Paused', error: 'Translation failed. Resume to try again.', visible: 'Translation failed. Resume to try again.' },
  ])('shows translated text or a persistent error without insertion controls: $status', ({ text, status, error, visible }) => {
    const Caption = (OverlayModule as unknown as {
      SubtitleCaption?: ComponentType<CaptionProps>
    }).SubtitleCaption
    const markup = Caption ? renderToStaticMarkup(createElement(Caption, { text, status, error })) : ''

    expect(markup).toContain(visible)
    expect(markup).toContain(status)
    expect(markup).toContain('data-overlay-content')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<speech>')
  })
})

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SubtitleCaption } from '../Overlay'

describe('translated subtitle markup', () => {
  it.each([
    { text: 'Translated <speech>', status: 'Listening to computer audio', error: '', visible: 'Translated &lt;speech&gt;' },
    { text: '', status: 'Paused', error: 'Translation failed. Resume to try again.', visible: 'Translation failed. Resume to try again.' },
  ])('shows translated text or a persistent error without insertion controls: $status', ({ text, status, error, visible }) => {
    const markup = renderToStaticMarkup(createElement(SubtitleCaption, { text, status, error }))

    expect(markup).toContain(visible)
    expect(markup).toContain(status)
    expect(markup).toContain('data-overlay-content')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<speech>')
  })
})

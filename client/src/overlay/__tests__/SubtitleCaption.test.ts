import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SubtitleCaption } from '../Overlay'

describe('translated subtitle markup', () => {
  it.each([
    { text: 'Translated <speech>', status: 'Listening to computer audio', notice: '', error: '', visible: 'Translated &lt;speech&gt;' },
    { text: '', status: 'Paused', notice: '', error: 'Translation failed. Resume to try again.', visible: 'Translation failed. Resume to try again.' },
  ])('shows translated text or a persistent error without insertion controls: $status', ({ text, status, notice, error, visible }) => {
    const markup = renderToStaticMarkup(createElement(SubtitleCaption, { text, status, notice, error }))

    expect(markup).toContain(visible)
    expect(markup).toContain(status)
    expect(markup).toContain('data-overlay-content')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<speech>')
  })

  it('shows the untranslated mark in the status line and leaves the original caption styled like a translation', () => {
    const notice = 'Original text: this fragment was not translated.'
    const plain = renderToStaticMarkup(createElement(SubtitleCaption, { text: 'Original speech', status: 'Listening', notice: '', error: '' }))
    const marked = renderToStaticMarkup(createElement(SubtitleCaption, { text: 'Original speech', status: 'Listening', notice, error: '' }))
    const captionParagraph = (markup: string) => markup.slice(markup.indexOf('Original speech'), markup.indexOf('</p>', markup.indexOf('Original speech')) + '</p>'.length)

    expect(marked).toContain(notice)
    expect(captionParagraph(marked)).toBe(captionParagraph(plain))
  })
})

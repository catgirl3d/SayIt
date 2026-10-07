import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SubtitleCaption } from '../Overlay'

describe('translated subtitle markup', () => {
  it.each([
    { text: 'Translated <speech>', status: 'Listening to computer audio', notice: '', error: '', visible: 'Translated &lt;speech&gt;' },
    { text: '', status: 'Paused', notice: '', error: 'Translation failed. Resume to try again.', visible: 'Translation failed. Resume to try again.' },
  ])('shows translated text or a persistent error without insertion controls: $status', ({ text, status, notice, error, visible }) => {
    const markup = renderToStaticMarkup(createElement(SubtitleCaption, { text, source: '', status, notice, error }))

    expect(markup).toContain(visible)
    expect(markup).toContain(status)
    expect(markup).toContain('data-overlay-content')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<speech>')
  })

  it('shows the untranslated mark in the status line and leaves the original caption styled like a translation', () => {
    const notice = 'Original text: this fragment was not translated.'
    const plain = renderToStaticMarkup(createElement(SubtitleCaption, { text: 'Original speech', source: '', status: 'Listening', notice: '', error: '' }))
    const marked = renderToStaticMarkup(createElement(SubtitleCaption, { text: 'Original speech', source: '', status: 'Listening', notice, error: '' }))
    const captionParagraph = (markup: string) => markup.slice(markup.indexOf('Original speech'), markup.indexOf('</p>', markup.indexOf('Original speech')) + '</p>'.length)

    expect(marked).toContain(notice)
    expect(captionParagraph(marked)).toBe(captionParagraph(plain))
  })

  describe('dual subtitles', () => {
    const render = (props: { text: string; source: string; error?: string }) => renderToStaticMarkup(createElement(SubtitleCaption, { status: 'Listening', notice: '', error: '', ...props }))

    it('shows the recognized original above the translation, smaller and muted', () => {
      const markup = render({ text: 'Translated speech', source: 'Original speech' })

      expect(markup.indexOf('Original speech')).toBeGreaterThan(-1)
      expect(markup.indexOf('Original speech')).toBeLessThan(markup.indexOf('Translated speech'))
      const sourceParagraph = markup.slice(markup.lastIndexOf('<p', markup.indexOf('Original speech')), markup.indexOf('</p>', markup.indexOf('Original speech')))
      expect(sourceParagraph).toContain('text-sm')
      expect(sourceParagraph).toContain('--overlay-text-muted')
      expect(sourceParagraph).not.toContain('text-xl')
    })

    it('keeps the translation line as a muted placeholder while the translation is still pending', () => {
      const markup = render({ text: '', source: 'Original speech' })

      expect(markup).toContain('Original speech')
      expect(markup).toContain('…')
    })

    it('renders no source line or placeholder in the single-caption layout', () => {
      const markup = render({ text: 'Translated speech', source: '' })

      expect(markup).not.toContain('…')
      expect(markup.match(/<p/g)).toHaveLength(2)
    })

    it('escapes the recognized text', () => {
      const markup = render({ text: 'Translated speech', source: 'Original <b>speech</b>' })

      expect(markup).toContain('Original &lt;b&gt;speech&lt;/b&gt;')
      expect(markup).not.toContain('<b>')
    })

    it('shows only the error when one is present', () => {
      const markup = render({ text: 'Translated speech', source: 'Original speech', error: 'Translation failed.' })

      expect(markup).toContain('Translation failed.')
      expect(markup).not.toContain('Original speech')
      expect(markup).not.toContain('Translated speech')
    })
  })

  describe('quiet listening', () => {
    const render = (props: { text?: string; source?: string; status?: string; notice?: string; error?: string }) =>
      renderToStaticMarkup(createElement(SubtitleCaption, { text: '', source: '', status: '', notice: '', error: '', ...props }))

    it('shows no status line when there is nothing to report, leaving only the caption', () => {
      const markup = render({ text: 'Translated speech' })

      expect(markup).toContain('Translated speech')
      expect(markup.match(/<p/g)).toHaveLength(1)
    })

    it('draws nothing visible while idle, yet keeps a sized container for the overlay render probe', () => {
      const markup = render({})

      expect(markup).toContain('data-overlay-content')
      expect(markup).toContain('w-full')
      expect(markup).toContain('py-4')
      expect(markup).not.toContain('<p')
      expect(markup).toContain('background:transparent')
      expect(markup).toContain('border-color:transparent')
    })

    it.each([
      { name: 'a status', props: { status: 'Subtitles paused' }, visible: 'Subtitles paused' },
      { name: 'a notice', props: { notice: 'Original text: this fragment was not translated.' }, visible: 'this fragment was not translated' },
      { name: 'an error', props: { error: 'Translation failed.' }, visible: 'Translation failed.' },
      { name: 'only the recognized original', props: { source: 'Original speech' }, visible: 'Original speech' },
    ])('draws the visible bubble again for $name', ({ props, visible }) => {
      const markup = render(props)

      expect(markup).toContain(visible)
      expect(markup).toContain('background:var(--overlay-bg)')
      expect(markup).not.toContain('background:transparent')
    })
  })
})

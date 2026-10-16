import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { t } from '@/i18n'
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

describe('live subtitle layout', () => {
  const render = (props: {
    text?: string
    source?: string
    status?: string
    notice?: string
    error?: string
    liveText?: string
    liveRecognition?: boolean
  } = {}) => renderToStaticMarkup(createElement(SubtitleCaption, {
    text: '',
    source: '',
    status: '',
    notice: '',
    error: '',
    liveText: '',
    liveRecognition: true,
    ...props,
  }))

  it('renders the live original above the separate settled dual captions', () => {
    const markup = render({
      text: 'Settled translation',
      source: 'Settled original',
      liveText: 'Current original',
    })

    expect(markup).toContain('Current original')
    expect(markup.indexOf('Current original')).toBeLessThan(markup.indexOf('Settled original'))
    expect(markup.indexOf('Settled original')).toBeLessThan(markup.indexOf('Settled translation'))
    expect(markup).toContain('data-live-original')
    expect(markup).toContain('line-clamp-3')
  })

  it('hides the empty live region instead of painting blank cards and clips long display text', () => {
    const empty = render()
    const populated = render({ liveText: 'A long provisional original that continues beyond the visible lines' })
    const regionOpeningTag = (markup: string) => markup.match(/<div[^>]*data-live-original[^>]*>/)?.[0]

    expect(empty).not.toContain('data-live-original')
    expect(empty).not.toContain(t('systemAudio.liveOriginalLabel'))
    expect(empty).toContain('data-overlay-content')
    expect(empty).toContain('h-[384px]')
    const populatedRegionOpeningTag = regionOpeningTag(populated)
    expect(populatedRegionOpeningTag).toBeDefined()
    expect(populatedRegionOpeningTag).toContain('max-h-[30vh]')
    expect(populatedRegionOpeningTag).not.toMatch(/[\s"]h-\[/)
    expect(populatedRegionOpeningTag).toContain('shrink-0')
    expect(populated).toContain('overflow-hidden')
    expect(populated).toContain('line-clamp-3')
    const liveTextClasses = populated.match(/<p class="([^"]+)">A long provisional/)
    expect(liveTextClasses?.[1]).toContain('max-h-[calc(30vh-48px)]')
    expect(liveTextClasses?.[1]).not.toMatch(/[\s"]h-\[/)
  })

  it('keeps single-caption translation visually separate from the current original', () => {
    const markup = render({ text: 'Settled translation', liveText: 'Current original' })

    expect(markup).toContain('Current original')
    expect(markup.indexOf('Current original')).toBeLessThan(markup.indexOf('Settled translation'))
    expect(markup).toContain('data-live-original')
    expect(markup).not.toContain('Settled original')
  })

  it('shows the latest confirmed recognition once after the live phrase clears', () => {
    const markup = render({ text: 'Confirmed original', liveText: '' })

    expect(markup.match(/Confirmed original/g)).toHaveLength(1)
    expect(markup).not.toContain('data-live-original')
    expect(markup).toContain('data-overlay-settled')
  })

  it('bounds the dual-caption placeholder when its translation has not arrived', () => {
    const markup = render({ source: 'Confirmed original awaiting translation', text: '' })
    const placeholderClass = markup.match(/aria-hidden="true" class="([^"]+)"/)

    expect(placeholderClass?.[1]).toContain('max-h-[64px]')
    expect(placeholderClass?.[1]).toContain('[@media(max-height:399px)]:leading-6')
  })

  it('does not deduplicate identical live and settled text', () => {
    const markup = render({ text: 'Repeated phrase', liveText: 'Repeated phrase' })

    expect(markup.match(/Repeated phrase/g)).toHaveLength(2)
  })

  it('keeps status and error visible with a bounded live display', () => {
    const markup = render({
      liveText: 'Current original',
      status: 'Listening for computer audio',
      error: 'The live recognition stream stopped. Resume subtitles to continue.',
    })

    expect(markup).toContain('Current original')
    expect(markup).toContain('Listening for computer audio')
    expect(markup).toContain('The live recognition stream stopped.')
    expect(markup).toContain('max-h-[32px]')
    expect(markup).toContain('line-clamp-2')
    expect(markup).toContain('max-h-[72px]')
    expect(markup).toContain('line-clamp-3')
    expect(markup).toContain('data-live-original')
  })

  it('keeps an untranslated notice and persistent warning visible together in live mode', () => {
    const markup = render({
      text: 'The recognized original',
      notice: 'This fragment was not translated.',
      status: 'Dictionary warning remains active.',
    })

    expect(markup.indexOf('This fragment was not translated.')).toBeLessThan(markup.indexOf('Dictionary warning remains active.'))
    expect(markup).toContain('This fragment was not translated.')
    expect(markup).toContain('Dictionary warning remains active.')
  })

  it('retains the required untranslated and live-warning message combination', () => {
    const warning = [
      t('systemAudio.discontinuity'),
      t('asr.deepgramKeytermLimitWarning'),
      t('systemAudio.behind'),
    ].join(' ')
    const markup = render({
      notice: t('systemAudio.untranslated'),
      status: warning,
      source: 'Settled original',
      text: 'Settled translation',
    })

    expect(markup).toContain(t('systemAudio.untranslated'))
    expect(markup).toContain(t('systemAudio.discontinuity'))
    expect(markup).toContain(t('asr.deepgramKeytermLimitWarning'))
    expect(markup).toContain(t('systemAudio.behind'))
    expect(markup).toContain('max-h-[48px]')
    expect(markup).toContain('line-clamp-3')
  })

  it('bounds the complete live overlay budget and visibly clips long status and caption content', () => {
    const longNotice = `Untranslated notice ${'detail '.repeat(30)}`
    const longWarning = `Persistent dictionary warning ${'detail '.repeat(30)}`
    const longSource = `Settled original ${'detail '.repeat(30)}`
    const longTranslation = `Settled translation ${'detail '.repeat(30)}`
    const captionsAndWarnings = render({
      source: longSource,
      text: longTranslation,
      notice: longNotice,
      status: longWarning,
      liveText: `Current original ${'detail '.repeat(30)}`,
    })
    const longError = `Live recognition failed ${'detail '.repeat(30)}`
    const statusAndError = render({ notice: longNotice, status: longWarning, error: longError })

    expect(captionsAndWarnings).toContain('h-[384px]')
    expect(captionsAndWarnings).toContain('max-h-[calc(100vh-16px)]')
    expect(captionsAndWarnings).toContain('gap-2')
    expect(captionsAndWarnings).toContain('justify-end')
    expect(captionsAndWarnings).toContain('max-h-[30vh]')
    expect(captionsAndWarnings).toContain('max-h-[calc(30vh-48px)]')
    expect(captionsAndWarnings).toContain('[@media(max-height:399px)]:leading-4')
    expect(captionsAndWarnings).toContain('max-h-[calc(70vh-24px)]')
    expect(captionsAndWarnings).toContain('min-h-0')
    expect(captionsAndWarnings).toContain('overflow-hidden')
    expect(captionsAndWarnings).toContain('line-clamp-3')
    expect(captionsAndWarnings).toContain('max-h-[48px]')
    expect(captionsAndWarnings).toContain('[@media(max-height:299px)_and_(min-height:255px)]:max-h-[32px]')
    expect(captionsAndWarnings).toContain('[@media(max-height:254px)]:max-h-[12px]')
    expect(captionsAndWarnings).toContain('max-h-[60px]')
    expect(captionsAndWarnings).toContain('max-h-[96px]')
    expect(captionsAndWarnings).toContain('[@media(max-height:399px)]:max-h-[16px]')
    expect(captionsAndWarnings).toContain('[@media(max-height:399px)]:max-h-[24px]')
    expect(captionsAndWarnings).toContain('[@media(max-height:254px)]:max-h-[12px]')
    const liveTextClasses = captionsAndWarnings.match(/data-live-original="true"[^>]*>[\s\S]*?<p class="([^"]+)"[^>]*>Current original/)
    expect(liveTextClasses?.[1]).toContain('[@media(max-height:360px)_and_(min-height:261px)]:leading-4')
    expect(liveTextClasses?.[1]).toContain('[@media(max-height:399px)]:line-clamp-1')
    const liveSourceClasses = captionsAndWarnings.match(/<p class="([^"]+)"[^>]*>Settled original/)
    expect(liveSourceClasses?.[1]).toContain('line-clamp-3')
    const liveTranslationClasses = captionsAndWarnings.match(/<p class="([^"]+)"[^>]*>Settled translation/)
    expect(liveTranslationClasses?.[1]).toContain('line-clamp-3')
    expect(captionsAndWarnings).toContain(longNotice)
    expect(captionsAndWarnings).toContain(longWarning)
    expect(captionsAndWarnings).toContain(longSource)
    expect(captionsAndWarnings).toContain(longTranslation)
    expect(statusAndError).toContain('line-clamp-3')
    expect(statusAndError).toContain('[@media(max-height:360px)_and_(min-height:261px)]:max-h-[32px]')
    expect(statusAndError).toContain('max-h-[72px]')
    expect(statusAndError).toContain(longNotice)
    expect(statusAndError).toContain(longWarning)
    expect(statusAndError).toContain(longError)
  })

  it('ignores live text when the live-recognition flag is absent or false', () => {
    const absentFlag = renderToStaticMarkup(createElement(SubtitleCaption, {
      text: '',
      source: '',
      status: '',
      notice: '',
      error: '',
      liveText: 'Not a live subtitle',
    }))
    const markup = render({ liveRecognition: false, liveText: 'Not a live subtitle' })

    expect(markup).not.toContain('Not a live subtitle')
    expect(markup).not.toContain('data-live-original')
    expect(absentFlag).not.toContain('Not a live subtitle')
    expect(absentFlag).not.toContain('data-live-original')
  })

  it('preserves batch notice-over-status precedence without rendering live fields', () => {
    const markup = render({
      liveRecognition: false,
      liveText: 'Not a live subtitle',
      notice: 'This fragment was not translated.',
      status: 'Dictionary warning remains active.',
    })

    expect(markup).toContain('This fragment was not translated.')
    expect(markup).not.toContain('Dictionary warning remains active.')
    expect(markup).not.toContain('Not a live subtitle')
    expect(markup).not.toContain('data-live-original')
  })
})

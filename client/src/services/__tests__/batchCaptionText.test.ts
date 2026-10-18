import { describe, expect, it } from 'vitest'
import { cleanBatchCaptionText, endsSentence } from '../batchCaptionText'

const plain = { cutMidSpeech: false, continuesUnfinishedSentence: false, language: 'auto' }
const cut = { ...plain, cutMidSpeech: true }
const continuation = { ...plain, continuesUnfinishedSentence: true }

describe('cleanBatchCaptionText: mid-speech ellipsis', () => {
  it('removes a trailing ellipsis and the whitespace before it from a piece cut mid-speech', () => {
    expect(cleanBatchCaptionText('a new campaign...', cut)).toBe('a new campaign')
    expect(cleanBatchCaptionText('a new campaign ...', cut)).toBe('a new campaign')
    expect(cleanBatchCaptionText('a new campaign…', cut)).toBe('a new campaign')
    expect(cleanBatchCaptionText('a new campaign ….', { ...cut })).toBe('a new campaign ….')
  })

  it('keeps the text of a piece that ended with a pause the speaker finished', () => {
    expect(cleanBatchCaptionText('a new campaign...', { ...plain, cutMidSpeech: false })).toBe('a new campaign...')
  })

  it('leaves an ellipsis in the middle of the text alone', () => {
    expect(cleanBatchCaptionText('wait... then go...', cut)).toBe('wait... then go')
  })

  it('does not strip a two-dot run, which is not an ellipsis marker', () => {
    expect(cleanBatchCaptionText('a new campaign..', cut)).toBe('a new campaign..')
  })

  it('returns empty text when nothing but the ellipsis remains', () => {
    expect(cleanBatchCaptionText('...', cut)).toBe('')
    expect(cleanBatchCaptionText('  …  ', cut)).toBe('')
  })

  it('trims surrounding whitespace', () => {
    expect(cleanBatchCaptionText('  Hello there  ', plain)).toBe('Hello there')
  })
})

describe('cleanBatchCaptionText: continuation lowercasing', () => {
  it('lowercases the first letter of a continuation of an unfinished sentence', () => {
    expect(cleanBatchCaptionText('Fostering system works', continuation)).toBe('fostering system works')
    expect(cleanBatchCaptionText('Believe they could', continuation)).toBe('believe they could')
  })

  it('lowercases a Cyrillic capital', () => {
    expect(cleanBatchCaptionText('Фінансування триває', continuation)).toBe('фінансування триває')
  })

  it('does nothing without the continuation flag', () => {
    expect(cleanBatchCaptionText('Fostering system works', plain)).toBe('Fostering system works')
  })

  it('does nothing when the first character is not an uppercase letter', () => {
    expect(cleanBatchCaptionText('fostering system', continuation)).toBe('fostering system')
    expect(cleanBatchCaptionText('2024 was good', continuation)).toBe('2024 was good')
    expect(cleanBatchCaptionText('"Quoted start', continuation)).toBe('"Quoted start')
  })

  it('keeps "I" and its contractions capitalized', () => {
    expect(cleanBatchCaptionText('I think so', continuation)).toBe('I think so')
    expect(cleanBatchCaptionText("I'm sure", continuation)).toBe("I'm sure")
    expect(cleanBatchCaptionText("I've seen it", continuation)).toBe("I've seen it")
    expect(cleanBatchCaptionText("I'll go", continuation)).toBe("I'll go")
    expect(cleanBatchCaptionText("I'd agree", continuation)).toBe("I'd agree")
    expect(cleanBatchCaptionText('I’m sure', continuation)).toBe('I’m sure')
  })

  it('lowercases words that only start with I', () => {
    expect(cleanBatchCaptionText('Iraq was small', continuation)).toBe('iraq was small')
    expect(cleanBatchCaptionText('Ill be there', continuation)).toBe('ill be there')
  })

  it('keeps all-caps acronyms of two or more letters', () => {
    expect(cleanBatchCaptionText('NASA launched it', continuation)).toBe('NASA launched it')
    expect(cleanBatchCaptionText('BBC reported it', continuation)).toBe('BBC reported it')
    expect(cleanBatchCaptionText("NASA's plan", continuation)).toBe("NASA's plan")
  })

  it('lowercases a single capital letter that is not "I"', () => {
    expect(cleanBatchCaptionText('A new campaign', continuation)).toBe('a new campaign')
  })

  it('does not lowercase German text, whatever the region code', () => {
    expect(cleanBatchCaptionText('Fostering system', { ...continuation, language: 'de' })).toBe('Fostering system')
    expect(cleanBatchCaptionText('Fostering system', { ...continuation, language: 'de-DE' })).toBe('Fostering system')
    expect(cleanBatchCaptionText('Fostering system', { ...continuation, language: 'DE_at' })).toBe('Fostering system')
  })

  it('still lowercases for languages that merely start with the letters d and e', () => {
    expect(cleanBatchCaptionText('Fostering system', { ...continuation, language: 'dutch' })).toBe('fostering system')
    expect(cleanBatchCaptionText('Fostering system', { ...continuation, language: 'en' })).toBe('fostering system')
  })

  it('returns empty text unchanged', () => {
    expect(cleanBatchCaptionText('', continuation)).toBe('')
  })
})

describe('cleanBatchCaptionText: combined guards', () => {
  it('removes the ellipsis first, then lowercases the cleaned text', () => {
    expect(cleanBatchCaptionText('Fostering system...', { ...cut, continuesUnfinishedSentence: true })).toBe('fostering system')
  })

  it('returns empty when the ellipsis is the only content, even for a continuation', () => {
    expect(cleanBatchCaptionText('...', { ...cut, continuesUnfinishedSentence: true })).toBe('')
  })
})

describe('endsSentence', () => {
  it('recognizes Latin and Cyrillic sentence enders', () => {
    expect(endsSentence('It is done.')).toBe(true)
    expect(endsSentence('Is it done?')).toBe(true)
    expect(endsSentence('It is done!')).toBe(true)
    expect(endsSentence('Це зроблено.')).toBe(true)
  })

  it('recognizes CJK sentence enders', () => {
    expect(endsSentence('这是结束。')).toBe(true)
    expect(endsSentence('真的吗？')).toBe(true)
    expect(endsSentence('太好了！')).toBe(true)
  })

  it('recognizes closing quotes and brackets after an ender', () => {
    expect(endsSentence('He said "it is done."')).toBe(true)
    expect(endsSentence('He said “it is done.”')).toBe(true)
    expect(endsSentence('It is done (really.)')).toBe(true)
  })

  it('treats a kept ellipsis, in either form, as an end of the text for the continuation check', () => {
    expect(endsSentence('and then…')).toBe(true)
    expect(endsSentence('and then...')).toBe(true)
  })

  it('does not treat unfinished text as ended', () => {
    expect(endsSentence('a new campaign')).toBe(false)
    expect(endsSentence('a new campaign,')).toBe(false)
    expect(endsSentence('')).toBe(false)
  })
})

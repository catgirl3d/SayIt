import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/useT', () => ({
  useT: () => (key: string) => key,
}))

import SpeechLanguageSelect from '../SpeechLanguageSelect'

describe('speech language select', () => {
  it.each([
    { value: 'auto', labelKey: 'common.auto' },
    { value: 'ru', labelKey: 'local.lang.ru' },
    { value: 'uk', labelKey: 'local.lang.uk' },
    { value: 'en', labelKey: 'local.lang.en' },
    { value: 'zh', labelKey: 'local.lang.zh' },
  ] as const)('maps $value to its translation key', ({ value, labelKey }) => {
    const markup = renderToStaticMarkup(createElement(SpeechLanguageSelect, { value, onChange: () => undefined }))

    expect(markup).toContain(labelKey)
  })
})

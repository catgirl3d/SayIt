import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const hookStateOverrides = vi.hoisted(() => ({ values: [] as unknown[] }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: <T,>(initialValue: T) => {
      if (hookStateOverrides.values.length > 0) {
        return [hookStateOverrides.values.shift() as T, () => {}]
      }
      return actual.useState(initialValue)
    },
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
  }
})

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>()
  return { ...actual, createPortal: (children: React.ReactNode) => children }
})

import { ModelLanguageBadge } from '../ModelLanguageBadge'

afterEach(() => {
  hookStateOverrides.values = []
  vi.unstubAllGlobals()
})

describe('Model language popover surface', () => {
  it('opens on the popover surface so it does not blend with cards', () => {
    hookStateOverrides.values = [true, '', { top: 100, left: 20 }]
    vi.stubGlobal('document', { body: {} })

    const markup = renderToStaticMarkup(createElement(ModelLanguageBadge, {
      model: { id: 'whisper-large-v3', name: 'Whisper Large v3', languages: ['en', 'uk'] },
      badgeLanguage: 'en',
    }))

    expect(markup).toContain('bg-popover')
    expect(markup).not.toContain('bg-card')
  })
})

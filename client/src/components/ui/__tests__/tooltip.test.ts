import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useEffect: () => undefined, useLayoutEffect: () => undefined }
})

vi.mock('react-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom')>()
  return { ...actual, createPortal: (children: React.ReactNode) => children }
})

import { Tooltip } from '../tooltip'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Tooltip light variant surface', () => {
  it('uses the popover surface so long help panels do not blend with cards', () => {
    vi.stubGlobal('document', { body: {} })

    const markup = renderToStaticMarkup(
      createElement(Tooltip, {
        variant: 'light',
        content: 'Help text',
        forceVisible: true,
        children: createElement('span', null, 'i'),
      }),
    )

    expect(markup).toContain('bg-popover')
    expect(markup).not.toContain('bg-card')
  })
})

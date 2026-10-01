import { createElement, type ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import * as OverlayModule from '../Overlay'

interface FailureCardProps {
  title: string
  detail: string
  recovery: 'unknown' | 'history' | 'none'
  onDismiss: () => void
}

describe('failure card markup', () => {
  it('renders the safe cause and actual recovery hint without transcript copy controls', () => {
    const FailureCard = (OverlayModule as unknown as {
      OverlayFailureCard?: ComponentType<FailureCardProps>
    }).OverlayFailureCard
    const markup = FailureCard
      ? renderToStaticMarkup(createElement(FailureCard, {
        title: 'Recognition failed',
        detail: 'The provider rejected this request. Check the selected account and try again.',
        recovery: 'history',
        onDismiss: () => undefined,
      }))
      : ''

    expect(markup).toContain('Recognition failed')
    expect(markup).toContain('The provider rejected this request. Check the selected account and try again.')
    expect(markup).toContain('Retry recognition from History')
    expect(markup).toContain('aria-label="Dismiss recognition error"')
    expect(markup).not.toContain('Copy text')
  })
})

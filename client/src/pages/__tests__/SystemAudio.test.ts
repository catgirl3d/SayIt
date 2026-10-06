import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SystemAudioControls } from '../SystemAudio'

describe('subtitle session controls', () => {
  it.each([
    { state: 'idle', action: 'Start subtitles', excluded: 'Pause' },
    { state: 'listening', action: 'Pause', excluded: 'Start subtitles' },
    { state: 'paused', action: 'Resume', excluded: 'Start subtitles' },
    { state: 'error', action: 'Resume', excluded: 'Start subtitles' },
  ] as const)('exposes the action belonging to the actual $state session', ({ state, action, excluded }) => {
    const markup = renderToStaticMarkup(createElement(SystemAudioControls, { state, busy: false, onAction: () => undefined }))
    expect(markup).toContain(action)
    expect(markup).not.toContain(excluded)
    if (state !== 'idle') expect(markup).toContain('Stop and return to dictation')
  })

  it('keeps Stop available during startup but prevents duplicate stop requests during handback', () => {
    for (const state of ['starting', 'stopping'] as const) {
      const markup = renderToStaticMarkup(createElement(SystemAudioControls, { state, busy: true, onAction: () => undefined }))
      expect(markup).toContain('Stop and return to dictation')
      expect(markup.includes('disabled=""')).toBe(state === 'stopping')
    }
  })
})

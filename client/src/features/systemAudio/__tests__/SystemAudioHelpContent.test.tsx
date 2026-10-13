// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { t } from '@/i18n'
import SystemAudioHelpContent from '../SystemAudioHelpContent'

function renderHelp() {
  return render(<MemoryRouter><SystemAudioHelpContent /></MemoryRouter>)
}

describe('computer subtitles help content', () => {
  it('leads with what the page does and groups the notes into titled sections', () => {
    renderHelp()

    expect(screen.getByText(t('systemAudio.helpIntro'))).toBeTruthy()
    const headings = screen.getAllByRole('heading', { level: 4 }).map(({ textContent }) => textContent)
    expect(headings).toEqual([
      t('systemAudio.helpSourceTitle'),
      t('systemAudio.helpLanguagesTitle'),
      t('systemAudio.helpDelayTitle'),
      t('systemAudio.helpPrivacyTitle'),
      t('systemAudio.helpEngineTitle'),
    ])
  })

  it('keeps the voice engine and AI provider links in the engine section', () => {
    renderHelp()

    expect(screen.getByRole('link', { name: t('nav.voiceEngine') }).getAttribute('href')).toBe('/voice-engine')
    expect(screen.getByRole('link', { name: t('nav.aiService') }).getAttribute('href')).toBe('/ai-service')
  })
})

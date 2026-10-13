// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { PageHelp } from '../PageHelp'
import { AiServiceHelpContent, VoiceEngineHelpContent } from '../HelpContents'
import { AI_PROVIDERS } from '../aiProviderCatalog'
import { ASR_PLATFORMS } from '../asrProviderCatalog'

const shellMocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('@tauri-apps/plugin-shell', () => ({ open: shellMocks.open }))

/** The list that holds the console links, located through the Groq row. */
function consoleList(): HTMLElement {
  const list = screen.getByText('Groq').closest('li')?.closest('ul')
  if (!list) throw new Error('Console list not found')
  return list
}

describe('PageHelp', () => {
  it('keeps the dialog hidden until the Help button is clicked', () => {
    render(<PageHelp title="Voice engine help"><p>help body</p></PageHelp>)

    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: t('help.button') }))

    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByText('Voice engine help')).toBeTruthy()
    expect(screen.getByText('help body')).toBeTruthy()
  })

  it('closes the dialog from the close button', () => {
    render(<PageHelp title="Voice engine help"><p>help body</p></PageHelp>)

    fireEvent.click(screen.getByRole('button', { name: t('help.button') }))
    fireEvent.click(screen.getByRole('button', { name: t('window.close') }))

    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('help content console links', () => {
  beforeEach(() => shellMocks.open.mockReset())

  it('opens the Deepgram console from the Voice engine help', () => {
    render(<VoiceEngineHelpContent />)

    fireEvent.click(screen.getByRole('button', {
      name: t('asr.openConsole', { platform: ASR_PLATFORMS.deepgram.label }),
    }))

    expect(shellMocks.open).toHaveBeenCalledWith(ASR_PLATFORMS.deepgram.consoleUrl)
  })

  it('opens the provider console from the AI providers help', () => {
    const deepseek = AI_PROVIDERS.find((provider) => provider.value === 'deepseek')
    if (!deepseek?.consoleUrl) throw new Error('DeepSeek is missing from the AI provider catalog')

    render(<AiServiceHelpContent />)

    fireEvent.click(screen.getByRole('button', {
      name: t('ai.openConsole', { provider: deepseek.label }),
    }))

    expect(shellMocks.open).toHaveBeenCalledWith(deepseek.consoleUrl)
  })

  it('marks Groq and Deepgram as recommended in the Voice engine help', () => {
    render(<VoiceEngineHelpContent />)

    for (const name of ['Groq', 'Deepgram']) {
      const row = screen.getByText(name).closest('li')
      if (!row) throw new Error(`${name} row not found`)
      expect(within(row).getByLabelText(t('local.recommended'))).toBeTruthy()
    }
    expect(screen.getAllByLabelText(t('local.recommended'))).toHaveLength(2)
  })

  it('marks Groq as the recommended entry in the AI providers help', () => {
    render(<AiServiceHelpContent />)

    const row = screen.getByText('Groq').closest('li')
    if (!row) throw new Error('Groq row not found')
    expect(within(row).getByLabelText(t('local.recommended'))).toBeTruthy()
    expect(screen.getAllByLabelText(t('local.recommended'))).toHaveLength(1)
  })

  it('orders recommended entries first and OpenAI and OpenRouter right after them', () => {
    render(<VoiceEngineHelpContent />)

    const rows = Array.from(consoleList().children)
    expect(rows[0].textContent).toContain('Groq')
    expect(rows[1].textContent).toContain('Deepgram')
    expect(rows[2].textContent).toContain('OpenAI')
    expect(rows[3].textContent).toContain('OpenRouter')
  })

  it('keeps Groq first in the AI providers help', () => {
    render(<AiServiceHelpContent />)

    expect(consoleList().children[0].textContent).toContain('Groq')
  })

  it('reveals the recommendation notes on click and hides them again', () => {
    render(<VoiceEngineHelpContent />)
    const freeTier = t('help.groq.free').split('**')[1]
    const credit = t('help.deepgram.credit').split('**')[1]

    expect(screen.queryByText(freeTier)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Groq/ }))
    expect(screen.getByText(freeTier)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Groq/ }))
    expect(screen.queryByText(freeTier)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Deepgram/ }))
    expect(screen.getByText(credit)).toBeTruthy()
  })

  it('reveals the recommendation notes in the AI providers help too', () => {
    render(<AiServiceHelpContent />)
    const freeTier = t('help.groq.free').split('**')[1]

    expect(screen.queryByText(freeTier)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Groq/ }))
    expect(screen.getByText(freeTier)).toBeTruthy()
  })

  it('lists the recommended Groq speech models as plain tags once the row is expanded', () => {
    render(<VoiceEngineHelpContent />)

    expect(screen.queryByRole('list', { name: t('help.recommendedModels') })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /^Groq/ }))

    const list = screen.getByRole('list', { name: t('help.recommendedModels') })
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(1)
    // The models are information only, not controls.
    expect(within(list).queryAllByRole('button')).toHaveLength(0)
  })

  it('shows no model list for a recommended provider that has no curated models', () => {
    render(<VoiceEngineHelpContent />)
    const credit = t('help.deepgram.credit').split('**')[1]

    fireEvent.click(screen.getByRole('button', { name: /^Deepgram/ }))

    expect(screen.getByText(credit)).toBeTruthy()
    expect(screen.queryByRole('list', { name: t('help.recommendedModels') })).toBeNull()
  })

  it('lists the recommended Groq models in the AI providers help too', () => {
    render(<AiServiceHelpContent />)

    fireEvent.click(screen.getByRole('button', { name: /^Groq/ }))

    const list = screen.getByRole('list', { name: t('help.recommendedModels') })
    expect(within(list).getAllByRole('listitem').length).toBeGreaterThan(0)
  })
})

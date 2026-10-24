// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'
import { setAiEnabled } from '@/stores/aiEnabled'

const storeMocks = vi.hoisted(() => ({ getSetting: vi.fn(), setSetting: vi.fn() }))

vi.mock('@/services/store', () => ({
  getSetting: storeMocks.getSetting,
  setSetting: storeMocks.setSetting,
}))

import HotwordPromptInjectToggle from '../HotwordPromptInjectToggle'

describe('HotwordPromptInjectToggle AI state', () => {
  beforeEach(async () => {
    storeMocks.getSetting.mockReset().mockImplementation(async (key: string, fallback: unknown) => (
      key === 'injectHotwordsToPrompt' ? true : fallback
    ))
    storeMocks.setSetting.mockReset().mockResolvedValue(undefined)
    await setAiEnabled(false)
  })

  afterEach(async () => {
    await setAiEnabled(false)
  })

  it('keeps the saved choice visible but disabled while AI processing is off', async () => {
    render(<HotwordPromptInjectToggle />)

    const toggle = await screen.findByRole('switch', { name: t('hotwordInject.title') })
    await waitFor(() => expect(toggle.getAttribute('aria-checked')).toBe('true'))
    expect((toggle as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(t('hotwordInject.disabledReason'))).toBeTruthy()

    fireEvent.click(toggle)
    expect(storeMocks.setSetting).not.toHaveBeenCalledWith('injectHotwordsToPrompt', expect.anything())
  })

  it('enables the saved choice again when AI processing is on', async () => {
    await setAiEnabled(true)
    render(<HotwordPromptInjectToggle />)

    const toggle = await screen.findByRole('switch', { name: t('hotwordInject.title') })
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false))
    expect(toggle.getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(t('hotwordInject.disabledReason'))).toBeNull()
  })
})

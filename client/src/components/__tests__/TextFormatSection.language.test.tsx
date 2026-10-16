// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import TextFormatSection from '../TextFormatSection'
import * as bridge from '@/services/bridge'
import { DEFAULT_POST_PROCESS } from '@/services/textPostProcess'
import { setAiEnabled } from '@/stores/aiEnabled'
import { t } from '@/i18n'

const storedSettings = new Map<string, unknown>()

function renderWithStoredSettings(settings: Record<string, unknown>) {
  for (const [key, value] of Object.entries(settings)) storedSettings.set(key, value)
  render(<TextFormatSection />)
}

describe('TextFormatSection speech-language visibility', () => {
  beforeEach(async () => {
    storedSettings.clear()
    vi.spyOn(bridge, 'storeGet').mockImplementation(async (key) => storedSettings.get(key) ?? null)
    vi.spyOn(bridge, 'storeSet').mockImplementation(async (key, value) => {
      storedSettings.set(key, value)
    })
    vi.spyOn(bridge, 'setTrayAiEnabled').mockResolvedValue(undefined)
    await setAiEnabled(false)
  })

  afterEach(async () => {
    await setAiEnabled(false)
    vi.restoreAllMocks()
  })

  it('shows the Chinese-only toggles when the speech language is Chinese', async () => {
    renderWithStoredSettings({
      textPostProcess: DEFAULT_POST_PROCESS,
      'speechInput.language': 'zh',
    })

    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(4))
    expect(screen.getByText(t('textFormat.autoSegment.title'))).toBeTruthy()
    expect(screen.getByText(t('textFormat.normalizeNumbers.title'))).toBeTruthy()
  })

  it('hides the Chinese-only toggles for other speech languages', async () => {
    renderWithStoredSettings({
      textPostProcess: DEFAULT_POST_PROCESS,
      'speechInput.language': 'uk',
    })

    await waitFor(() => expect(screen.getAllByRole('switch')).toHaveLength(2))
    expect(screen.queryByText(t('textFormat.autoSegment.title'))).toBeNull()
    expect(screen.queryByText(t('textFormat.normalizeNumbers.title'))).toBeNull()
    expect(screen.getByText(t('textFormat.stripTrailing.title'))).toBeTruthy()
    expect(screen.getByText(t('textFormat.punctuationToSpace.title'))).toBeTruthy()
  })
})

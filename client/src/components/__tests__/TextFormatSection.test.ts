import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import TextFormatSection from '../TextFormatSection'
import { getTextPostProcessOptions, saveTextPostProcessOptions, type TextPostProcessOptions } from '@/services/textPostProcess'
import * as bridge from '@/services/bridge'
import { setAiEnabled } from '@/stores/aiEnabled'

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
    useSyncExternalStore: <T,>(_subscribe: unknown, getSnapshot: () => T) => getSnapshot(),
    useEffect: () => undefined,
    useLayoutEffect: () => undefined,
  }
})

vi.mock('@/i18n/useT', () => ({ useT: () => (key: string) => key }))

const storedSettings = new Map<string, unknown>()
const savedOptions: TextPostProcessOptions = {
  autoSegment: false,
  normalizeNumbers: true,
  stripTrailingPunctuation: true,
  punctuationToSpace: false,
}

beforeEach(async () => {
  storedSettings.clear()
  vi.spyOn(bridge, 'storeGet').mockImplementation(async (key) => storedSettings.get(key) ?? null)
  vi.spyOn(bridge, 'storeSet').mockImplementation(async (key, value) => {
    storedSettings.set(key, value)
  })
  vi.spyOn(bridge, 'setTrayAiEnabled').mockResolvedValue(undefined)
  await setAiEnabled(false)
  vi.clearAllMocks()
})

afterEach(async () => {
  await setAiEnabled(false)
  hookStateOverrides.values = []
  vi.restoreAllMocks()
})

function renderWithSavedOptions() {
  // useState order: opts, ready, animate, showChineseOnlyToggles
  hookStateOverrides.values = [savedOptions, true, true, true]
  return renderToStaticMarkup(createElement(TextFormatSection))
}

function getSwitchMarkup(markup: string) {
  return markup.match(/<button\b[^>]*role="switch"[^>]*>/g) || []
}

describe('TextFormatSection AI state', () => {
  it('disables named switches while AI is enabled without changing saved choices', async () => {
    await saveTextPostProcessOptions(savedOptions)
    expect(await getTextPostProcessOptions()).toEqual(savedOptions)

    await setAiEnabled(true)
    const enabledMarkup = renderWithSavedOptions()
    const enabledSwitches = getSwitchMarkup(enabledMarkup)

    expect(enabledSwitches).toHaveLength(4)
    expect(enabledSwitches.every((element) => element.includes('disabled=""'))).toBe(true)
    expect(enabledSwitches.map((element) => element.match(/aria-checked="(true|false)"/)?.[1])).toEqual([
      'false',
      'true',
      'true',
      'false',
    ])
    const labelIds = [
      'text-format-autoSegment-label',
      'text-format-normalizeNumbers-label',
      'text-format-stripTrailingPunctuation-label',
      'text-format-punctuationToSpace-label',
    ]
    expect(enabledSwitches.map((element) => element.match(/aria-labelledby="([^"]+)"/)?.[1])).toEqual(labelIds)
    for (const labelId of labelIds) expect(enabledMarkup).toContain(`id="${labelId}"`)
    expect(await getTextPostProcessOptions()).toEqual(savedOptions)

    await setAiEnabled(false)
    const disabledMarkup = renderWithSavedOptions()
    const disabledSwitches = getSwitchMarkup(disabledMarkup)

    expect(disabledSwitches).toHaveLength(4)
    expect(disabledSwitches.every((element) => !element.includes('disabled=""'))).toBe(true)
    expect(disabledSwitches.map((element) => element.match(/aria-checked="(true|false)"/)?.[1])).toEqual([
      'false',
      'true',
      'true',
      'false',
    ])
    expect(await getTextPostProcessOptions()).toEqual(savedOptions)
    expect(vi.mocked(bridge.storeSet).mock.calls.filter(([key]) => key === 'textPostProcess')).toHaveLength(1)
  })
})

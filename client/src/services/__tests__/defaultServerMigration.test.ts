import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ storeGet: vi.fn() }))
const setSetting = vi.hoisted(() => vi.fn())
const getBackendBaseUrl = vi.hoisted(() => vi.fn())
const getStoredBackendBaseUrl = vi.hoisted(() => vi.fn())
const resetBackendBaseUrl = vi.hoisted(() => vi.fn())

vi.mock('@/services/bridge', () => bridge)
vi.mock('@/services/store', () => ({ setSetting }))
vi.mock('@/services/runtimeConfig', () => ({
  getBackendBaseUrl,
  getStoredBackendBaseUrl,
  resetBackendBaseUrl,
}))

import {
  completeDefaultServerMigration,
  resolveDefaultServerMigration,
} from '../defaultServerMigration'

const FLAG_KEY = 'migration.builtinServerRemoved'
const LEGACY_URL = 'https://sayitapp.site'

function seed(values: Record<string, unknown>) {
  bridge.storeGet.mockImplementation(async (key: string) => (key in values ? values[key] : null))
}

const cases: Array<{
  name: string
  values: Record<string, unknown>
  url: string
  storedUrl?: string
  expected: 'none' | 'choose'
  resets?: boolean
  writesServer?: boolean
  writesFlag: boolean
}> = [
  {
    name: 'a: fresh install without onboarding version',
    values: { onboardingVersion: null, workMode: 'server' },
    url: 'https://server.example',
    expected: 'none',
    writesFlag: true,
  },
  {
    name: 'a: empty onboarding version wins over a saved mode',
    values: { onboardingVersion: '', workMode: 'server' },
    url: '',
    expected: 'none',
    writesFlag: true,
  },
  {
    name: 'b: saved local mode',
    values: { onboardingVersion: '1.0.0', workMode: 'local' },
    url: '',
    expected: 'none',
    writesFlag: true,
  },
  {
    name: 'b: saved cloud mode',
    values: { onboardingVersion: '1.0.0', workMode: 'cloud_api' },
    url: 'https://server.example',
    expected: 'none',
    writesFlag: true,
  },
  {
    name: 'd: unset mode with a configured address',
    values: { onboardingVersion: '1.0.0', workMode: null },
    url: 'https://server.example',
    expected: 'none',
    writesServer: true,
    writesFlag: true,
  },
  {
    name: 'd: undefined mode with a configured address',
    values: { onboardingVersion: '1.0.0', workMode: undefined },
    url: 'https://server.example',
    expected: 'none',
    writesServer: true,
    writesFlag: true,
  },
  {
    name: 'e: unset mode without an address',
    values: { onboardingVersion: '1.0.0', workMode: null },
    url: '',
    expected: 'choose',
    writesFlag: false,
  },
  {
    name: 'e: server mode without an address',
    values: { onboardingVersion: '1.0.0', workMode: 'server' },
    url: '',
    expected: 'choose',
    writesFlag: false,
  },
  {
    name: 'f: server mode with a configured address',
    values: { onboardingVersion: '1.0.0', workMode: 'server' },
    url: 'https://server.example',
    expected: 'none',
    writesFlag: true,
  },
  {
    name: 'g: garbage mode without an address',
    values: { onboardingVersion: '1.0.0', workMode: 'garbage' },
    url: '',
    expected: 'none',
    writesFlag: true,
  },
  {
    name: 'g: garbage mode with an address',
    values: { onboardingVersion: '1.0.0', workMode: 'garbage' },
    url: 'https://server.example',
    expected: 'none',
    writesFlag: true,
  },
  {
    name: 'completed: legacy host is left alone when the flag is set',
    values: { onboardingVersion: '1.0.0', workMode: null, [FLAG_KEY]: true },
    url: '',
    storedUrl: `${LEGACY_URL}/`,
    expected: 'none',
    resets: false,
    writesFlag: false,
  },
  {
    name: 'legacy host without a flag: remove it and ask for a mode',
    values: { onboardingVersion: '1.0.0', workMode: null },
    url: LEGACY_URL,
    storedUrl: LEGACY_URL,
    expected: 'choose',
    resets: true,
    writesFlag: false,
  },
  {
    name: 'legacy subdomain without a flag: remove it and ask for a mode',
    values: { onboardingVersion: '1.0.0', workMode: 'server' },
    url: 'https://www.sayitapp.site/',
    storedUrl: 'https://www.sayitapp.site/',
    expected: 'choose',
    resets: true,
    writesFlag: false,
  },
  {
    name: 'legacy host in mixed case: remove it and finish a local migration',
    values: { onboardingVersion: '1.0.0', workMode: 'local' },
    url: 'https://SayItApp.Site',
    storedUrl: 'https://SayItApp.Site',
    expected: 'none',
    resets: true,
    writesFlag: true,
  },
  {
    name: 'similar host without a flag: keep it and pin server mode',
    values: { onboardingVersion: '1.0.0', workMode: null },
    url: 'https://notsayitapp.site',
    storedUrl: 'https://notsayitapp.site',
    expected: 'none',
    resets: false,
    writesServer: true,
    writesFlag: true,
  },
  {
    name: 'legacy host as a subdomain label without a flag: keep it and pin server mode',
    values: { onboardingVersion: '1.0.0', workMode: null },
    url: 'https://sayitapp.site.evil.example',
    storedUrl: 'https://sayitapp.site.evil.example',
    expected: 'none',
    resets: false,
    writesServer: true,
    writesFlag: true,
  },
  {
    name: 'invalid stored address without a flag: do not reset',
    values: { onboardingVersion: '1.0.0', workMode: 'server' },
    url: 'not a url',
    storedUrl: 'not a url',
    expected: 'none',
    resets: false,
    writesFlag: true,
  },
]

function settingWrites(key: string) {
  return setSetting.mock.calls.filter(([writtenKey]) => writtenKey === key)
}

describe('default server migration', () => {
  beforeEach(() => {
    bridge.storeGet.mockReset()
    setSetting.mockReset().mockResolvedValue(undefined)
    getBackendBaseUrl.mockReset().mockReturnValue('')
    getStoredBackendBaseUrl.mockReset().mockResolvedValue('')
    resetBackendBaseUrl.mockReset().mockImplementation(async () => {
      getBackendBaseUrl.mockReturnValue('')
      return ''
    })
  })

  it.each(cases)('$name', async ({ values, url, storedUrl, expected, resets, writesServer, writesFlag }) => {
    seed(values)
    getBackendBaseUrl.mockReturnValue(url)
    getStoredBackendBaseUrl.mockResolvedValue(storedUrl ?? '')

    await expect(resolveDefaultServerMigration()).resolves.toBe(expected)

    if (resets) {
      expect(resetBackendBaseUrl).toHaveBeenCalledTimes(1)
    } else {
      expect(resetBackendBaseUrl).not.toHaveBeenCalled()
    }

    if (writesServer) {
      expect(settingWrites('workMode')).toEqual([['workMode', 'server']])
    } else {
      expect(settingWrites('workMode')).toEqual([])
    }

    if (writesFlag) {
      expect(settingWrites(FLAG_KEY)).toEqual([[FLAG_KEY, true]])
    } else {
      expect(settingWrites(FLAG_KEY)).toEqual([])
    }

    if (values[FLAG_KEY] === true) {
      expect(setSetting).not.toHaveBeenCalled()
    }
  })

  it('keeps an unset mode on server only when an address exists', async () => {
    seed({ onboardingVersion: '1.0.0', workMode: null })
    getBackendBaseUrl.mockReturnValue('https://server.example')

    await resolveDefaultServerMigration()

    expect(setSetting.mock.calls).toEqual([
      ['workMode', 'server'],
      [FLAG_KEY, true],
    ])
  })

  it('completeDefaultServerMigration writes the flag', async () => {
    await completeDefaultServerMigration()

    expect(setSetting).toHaveBeenCalledExactlyOnceWith(FLAG_KEY, true)
  })
})

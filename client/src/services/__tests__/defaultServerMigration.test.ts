import { beforeEach, describe, expect, it, vi } from 'vitest'

const bridge = vi.hoisted(() => ({ storeGet: vi.fn() }))
const setSetting = vi.hoisted(() => vi.fn())
const getBackendBaseUrl = vi.hoisted(() => vi.fn())

vi.mock('@/services/bridge', () => bridge)
vi.mock('@/services/store', () => ({ setSetting }))
vi.mock('@/services/runtimeConfig', () => ({ getBackendBaseUrl }))

import { resolveDefaultServerMigration } from '../defaultServerMigration'

function seed(values: Record<string, unknown>) {
  bridge.storeGet.mockImplementation(async (key: string) => (key in values ? values[key] : null))
}

const cases: Array<{
  name: string
  values: Record<string, unknown>
  url: string
  expected: 'none' | 'choose'
  writesServer?: boolean
}> = [
  {
    name: 'a: fresh install without onboarding version',
    values: { onboardingVersion: null, workMode: 'server' },
    url: 'https://server.example',
    expected: 'none',
  },
  {
    name: 'a: empty onboarding version wins over a saved mode',
    values: { onboardingVersion: '', workMode: 'server' },
    url: '',
    expected: 'none',
  },
  {
    name: 'b: saved local mode',
    values: { onboardingVersion: '1.0.0', workMode: 'local' },
    url: '',
    expected: 'none',
  },
  {
    name: 'b: saved cloud mode',
    values: { onboardingVersion: '1.0.0', workMode: 'cloud_api' },
    url: 'https://server.example',
    expected: 'none',
  },
  {
    name: 'd: unset mode with a configured address',
    values: { onboardingVersion: '1.0.0', workMode: null },
    url: 'https://server.example',
    expected: 'none',
    writesServer: true,
  },
  {
    name: 'd: undefined mode with a configured address',
    values: { onboardingVersion: '1.0.0', workMode: undefined },
    url: 'https://server.example',
    expected: 'none',
    writesServer: true,
  },
  {
    name: 'e: unset mode without an address',
    values: { onboardingVersion: '1.0.0', workMode: null },
    url: '',
    expected: 'choose',
  },
  {
    name: 'e: server mode without an address',
    values: { onboardingVersion: '1.0.0', workMode: 'server' },
    url: '',
    expected: 'choose',
  },
  {
    name: 'f: server mode with a configured address',
    values: { onboardingVersion: '1.0.0', workMode: 'server' },
    url: 'https://server.example',
    expected: 'none',
  },
  {
    name: 'g: garbage mode without an address',
    values: { onboardingVersion: '1.0.0', workMode: 'garbage' },
    url: '',
    expected: 'none',
  },
  {
    name: 'g: garbage mode with an address',
    values: { onboardingVersion: '1.0.0', workMode: 'garbage' },
    url: 'https://server.example',
    expected: 'none',
  },
]

describe('default server migration', () => {
  beforeEach(() => {
    bridge.storeGet.mockReset()
    setSetting.mockReset().mockResolvedValue(undefined)
    getBackendBaseUrl.mockReset().mockReturnValue('')
  })

  it.each(cases)('$name', async ({ values, url, expected, writesServer }) => {
    seed(values)
    getBackendBaseUrl.mockReturnValue(url)

    await expect(resolveDefaultServerMigration()).resolves.toBe(expected)

    if (writesServer) {
      expect(setSetting).toHaveBeenCalledExactlyOnceWith('workMode', 'server')
    } else {
      expect(setSetting).not.toHaveBeenCalled()
    }
  })

  it('keeps an unset mode on server only when an address exists', async () => {
    seed({ onboardingVersion: '1.0.0', workMode: null })
    getBackendBaseUrl.mockReturnValue('https://server.example')

    await resolveDefaultServerMigration()

    expect(setSetting).toHaveBeenCalledTimes(1)
    expect(setSetting).toHaveBeenCalledWith('workMode', 'server')
  })
})

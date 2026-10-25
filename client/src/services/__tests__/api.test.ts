import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from '@/i18n'

vi.mock('../runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runtimeConfig')>()
  return { ...actual, getBackendBaseUrl: vi.fn() }
})

import {
  getHotwords,
  getRecordings,
  healthCheck,
  healthCheckDetails,
} from '../api'
import { getBackendBaseUrl } from '../runtimeConfig'

describe('api without a configured server', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it.each([
    ['health check', () => healthCheck()],
    ['health check details', () => healthCheckDetails()],
    ['hotwords', () => getHotwords()],
    ['recordings', () => getRecordings()],
  ])('rejects %s without fetching', async (_name, call) => {
    vi.mocked(getBackendBaseUrl).mockReturnValue('')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)

    await expect(call()).rejects.toThrow(
      t('runtimeConfig.serverNotConfigured', { section: t('nav.voiceEngine') }),
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSetting: vi.fn(),
}))

vi.mock('../../store', () => ({
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
}))

import {
  getRuntimeServerAiSource,
  loadServerAiSource,
  readStoredServerAiSource,
  setRuntimeServerAiSource,
} from '../serverAiSource'

describe('server AI source', () => {
  beforeEach(() => {
    mocks.getSetting.mockReset()
    setRuntimeServerAiSource('managed')
  })

  it('reads a stored custom source', async () => {
    mocks.getSetting.mockResolvedValue('custom')

    await expect(readStoredServerAiSource()).resolves.toBe('custom')
  })

  it.each([
    { name: 'a managed value', stored: 'managed' },
    { name: 'an unknown value', stored: 'something-else' },
    { name: 'an unset value', stored: undefined },
  ])('reads $name as the managed source', async ({ stored }) => {
    mocks.getSetting.mockImplementation(async (_key: string, fallback: unknown) => (
      stored === undefined ? fallback : stored
    ))

    await expect(readStoredServerAiSource()).resolves.toBe('managed')
  })

  it('does not change the runtime source when reading the stored value', async () => {
    mocks.getSetting.mockResolvedValue('custom')

    await readStoredServerAiSource()

    expect(getRuntimeServerAiSource()).toBe('managed')
  })

  it('updates the runtime source from the stored value when loading', async () => {
    mocks.getSetting.mockResolvedValue('custom')

    await expect(loadServerAiSource()).resolves.toBe('custom')
    expect(getRuntimeServerAiSource()).toBe('custom')
  })
})

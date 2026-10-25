import { beforeEach, describe, expect, it, vi } from 'vitest'

const getSetting = vi.hoisted(() => vi.fn())
const addRuntimeEvent = vi.hoisted(() => vi.fn())

vi.mock('../../store', () => ({ getSetting }))
vi.mock('../../debugLog', () => ({ addRuntimeEvent }))

import { getWorkMode, initProviderFromStore } from '../index'

describe('provider initialization', () => {
  beforeEach(() => {
    getSetting.mockReset()
    addRuntimeEvent.mockReset()
  })

  it('defaults to local when workMode is not saved', async () => {
    getSetting.mockImplementation(async (_key: string, fallback: unknown) => fallback)

    await initProviderFromStore()

    expect(getWorkMode()).toBe('local')
  })
})

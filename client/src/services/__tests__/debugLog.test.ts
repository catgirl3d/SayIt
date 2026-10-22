import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../bridge', () => ({
  appendDebugLog: vi.fn(),
}))

import { appendDebugLog } from '../bridge'
import { addRuntimeEvent, clearRuntimeEvents, getRuntimeEvents } from '../debugLog'

describe('runtime event allowlist', () => {
  beforeEach(() => {
    clearRuntimeEvents()
    vi.mocked(appendDebugLog).mockClear()
  })

  it('drops an ordinary info event from a work-mode source', () => {
    addRuntimeEvent('info', 'server', 'Custom AI cleanup started', { provider: 'ollama' })

    expect(getRuntimeEvents()).toHaveLength(0)
    expect(appendDebugLog).not.toHaveBeenCalled()
  })

  it.each(['server', 'cloud_api', 'local', 'history', 'system_audio'])(
    'keeps and mirrors the ai.outcome record written by the %s source',
    (source) => {
      addRuntimeEvent('info', source, 'ai.outcome', { status: 'applied', attempted: true })

      expect(getRuntimeEvents()).toHaveLength(1)
      expect(getRuntimeEvents()[0]).toMatchObject({ source, message: 'ai.outcome', level: 'info' })
      expect(appendDebugLog).toHaveBeenCalledTimes(1)
      expect(appendDebugLog).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'runtime',
        message: 'ai.outcome',
        detail: { status: 'applied', attempted: true },
      }))
    },
  )

  it('keeps warnings from any source', () => {
    addRuntimeEvent('warn', 'server', 'Anything went wrong')

    expect(getRuntimeEvents()).toHaveLength(1)
  })
})

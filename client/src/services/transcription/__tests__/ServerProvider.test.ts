import { beforeEach, describe, expect, it, vi } from 'vitest'

const websocket = vi.hoisted(() => ({ supportsTextContext: vi.fn(() => false) }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn(), listen: vi.fn() }))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))
vi.mock('../../websocket', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../websocket')>(),
  supportsTextContext: websocket.supportsTextContext,
}))

import { ServerProvider } from '../ServerProvider'
import { setRuntimeServerAiSource } from '../serverAiSource'

describe('server provider text context support', () => {
  beforeEach(() => {
    websocket.supportsTextContext.mockReturnValue(false)
    setRuntimeServerAiSource('managed')
  })

  it('rejects context for the managed AI of a legacy server that only has the selection-edit shim', () => {
    expect(new ServerProvider().acceptsTextContext()).toBe(false)
  })

  it('accepts context for the managed AI of a server that advertises text_context', () => {
    websocket.supportsTextContext.mockReturnValue(true)
    expect(new ServerProvider().acceptsTextContext()).toBe(true)
  })

  it('accepts context for a custom AI regardless of the server, because this client builds that request', () => {
    setRuntimeServerAiSource('custom')
    expect(new ServerProvider().acceptsTextContext()).toBe(true)
  })
})

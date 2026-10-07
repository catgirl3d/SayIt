import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn() }))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => native.invoke(...args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  emit: vi.fn(async () => undefined),
  listen: vi.fn(async () => () => {}),
}))
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: vi.fn() }))

import { getLocale } from '@/i18n'
import { hideSubtitleOverlay, presentSubtitleOverlay, updateSubtitleOverlay } from '../../recorder'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('subtitle overlay recorder delegates', () => {
  beforeEach(() => {
    native.invoke.mockReset().mockImplementation(async (command: string) => {
      return command === 'present_overlay' ? 23 : undefined
    })
  })

  it('forwards the subtitle contract to the shared overlay bridge without dictation fields', async () => {
    const payload = {
      subtitleText: 'Translated caption',
      subtitleStatus: 'Listening',
      subtitleError: '',
      subtitleNotice: '',
    }
    const bridgePayload = { state: 'subtitles', ...payload, locale: getLocale() }
    const pendingPresent = deferred<number>()
    const pendingUpdate = deferred<void>()
    const pendingHide = deferred<void>()
    native.invoke.mockReset()
      .mockReturnValueOnce(pendingPresent.promise)
      .mockReturnValueOnce(pendingUpdate.promise)
      .mockReturnValueOnce(pendingHide.promise)

    let presentSettled = false
    let updateSettled = false
    let hideSettled = false
    const presented = presentSubtitleOverlay(payload).then((showId) => {
      presentSettled = true
      return showId
    })
    const updated = updateSubtitleOverlay(payload).then(() => { updateSettled = true })
    const hidden = hideSubtitleOverlay().then(() => { hideSettled = true })
    await Promise.resolve()

    expect([presentSettled, updateSettled, hideSettled]).toEqual([false, false, false])
    expect(native.invoke.mock.calls).toEqual([
      ['present_overlay', { data: bridgePayload }],
      ['update_overlay_state', { data: bridgePayload }],
      ['hide_overlay'],
    ])

    pendingPresent.resolve(23)
    pendingUpdate.resolve(undefined)
    pendingHide.resolve(undefined)
    await expect(presented).resolves.toBe(23)
    await Promise.all([updated, hidden])

    expect([presentSettled, updateSettled, hideSettled]).toEqual([true, true, true])
  })
})

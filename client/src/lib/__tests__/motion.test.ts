// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MOTION_CHANGE_EVENT,
  motionAllowed,
  setMotionEnabled,
  useMotionAllowed,
} from '../motion'

afterEach(() => {
  delete document.documentElement.dataset.motion
  vi.unstubAllGlobals()
})

describe('interface motion preference', () => {
  it('allows motion when nothing is turned off', () => {
    expect(motionAllowed()).toBe(true)
  })

  it('disables motion from the in-app switch', () => {
    setMotionEnabled(false)

    expect(document.documentElement.dataset.motion).toBe('off')
    expect(motionAllowed()).toBe(false)

    setMotionEnabled(true)

    expect(document.documentElement.dataset.motion).toBe('on')
    expect(motionAllowed()).toBe(true)
  })

  it('disables motion when the switch is off', () => {
    setMotionEnabled(false)

    expect(motionAllowed()).toBe(false)
  })

  it('does not dispatch a change event when the switch value is unchanged', () => {
    const changed = vi.fn()
    window.addEventListener(MOTION_CHANGE_EVENT, changed)
    try {
      setMotionEnabled(false)
      expect(changed).toHaveBeenCalledTimes(1)

      setMotionEnabled(false)
      setMotionEnabled(false)
      expect(changed).toHaveBeenCalledTimes(1)
    } finally {
      window.removeEventListener(MOTION_CHANGE_EVENT, changed)
    }
  })
})

describe('useMotionAllowed', () => {
  it('re-renders when the in-app switch changes', () => {
    const { result } = renderHook(() => useMotionAllowed())

    expect(result.current).toBe(true)

    act(() => setMotionEnabled(false))
    expect(result.current).toBe(false)

    act(() => setMotionEnabled(true))
    expect(result.current).toBe(true)
  })
})

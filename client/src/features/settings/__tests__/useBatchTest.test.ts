// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useBatchTest, type BatchRunResult } from '../useBatchTest'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('useBatchTest', () => {
  it('runs every item concurrently and updates progress as each one finishes', async () => {
    const first = deferred<string>()
    const second = deferred<string>()
    const runOne = vi.fn((item: { id: string }) => item.id === 'a' ? first.promise : second.promise)
    const commit = vi.fn(async () => {})
    const { result } = renderHook(() => useBatchTest<{ id: string }, string>({ runOne, commit }))

    let run!: Promise<void>
    act(() => {
      run = result.current.runBatch([{ id: 'a' }, { id: 'b' }])
    })

    expect(result.current.batch).toEqual({ done: 0, total: 2 })
    expect(result.current.runningIds).toEqual(['a', 'b'])
    expect(result.current.isRunning('a')).toBe(true)

    await act(async () => {
      first.resolve('first')
    })

    expect(result.current.batch).toEqual({ done: 1, total: 2 })
    expect(result.current.runningIds).toEqual(['b'])
    expect(result.current.isRunning('a')).toBe(false)
    expect(result.current.isRunning('b')).toBe(true)

    await act(async () => {
      second.resolve('second')
      await run
    })

    expect(commit).toHaveBeenCalledTimes(1)
    expect(result.current.batch).toBeNull()
    expect(result.current.runningIds).toEqual([])
  })

  it('keeps the batch state until commit finishes', async () => {
    const commitGate = deferred<void>()
    const runOne = vi.fn(async () => 'done')
    const commit = vi.fn(() => commitGate.promise)
    const { result } = renderHook(() => useBatchTest<{ id: string }, string>({ runOne, commit }))

    let run!: Promise<void>
    act(() => {
      run = result.current.runBatch([{ id: 'a' }])
    })

    await waitFor(() => expect(result.current.batch).toEqual({ done: 1, total: 1 }))
    expect(result.current.runningIds).toEqual([])

    commitGate.resolve()
    await act(async () => {
      await run
    })

    expect(result.current.batch).toBeNull()
  })

  it('prepares the shared resource once and passes it to every run', async () => {
    const prepare = vi.fn(async () => 'clip')
    const runOne = vi.fn(async (_item: { id: string }, prepared: string) => prepared)
    const commit = vi.fn(async () => {})
    const { result } = renderHook(() => useBatchTest<{ id: string }, string, string>({ prepare, runOne, commit }))

    await act(async () => {
      await result.current.runBatch([{ id: 'a' }, { id: 'b' }])
    })

    expect(prepare).toHaveBeenCalledTimes(1)
    expect(runOne).toHaveBeenCalledTimes(2)
    for (const call of runOne.mock.calls) expect(call[1]).toBe('clip')
  })

  it('publishes the batch state before the prepare step runs', async () => {
    const prepareGate = deferred<string>()
    const prepare = vi.fn(() => prepareGate.promise)
    const runOne = vi.fn(async (_item: { id: string }, prepared: string) => prepared)
    const commit = vi.fn(async () => {})
    const { result } = renderHook(() => useBatchTest<{ id: string }, string, string>({ prepare, runOne, commit }))

    let run!: Promise<void>
    act(() => {
      run = result.current.runBatch([{ id: 'a' }])
    })

    expect(result.current.batch).toEqual({ done: 0, total: 1 })
    expect(result.current.runningIds).toEqual(['a'])
    expect(runOne).not.toHaveBeenCalled()

    await act(async () => {
      prepareGate.resolve('clip')
      await run
    })

    expect(result.current.batch).toBeNull()
  })

  it('delivers results in input order even when runs finish out of order', async () => {
    const slow = deferred<number>()
    const fast = deferred<number>()
    const runOne = vi.fn((item: { id: string }) => item.id === 'slow' ? slow.promise : fast.promise)
    const commit = vi.fn(async (_results: BatchRunResult<{ id: string }, number>[]) => {})
    const { result } = renderHook(() => useBatchTest<{ id: string }, number>({ runOne, commit }))

    await act(async () => {
      const run = result.current.runBatch([{ id: 'slow' }, { id: 'fast' }])
      fast.resolve(2)
      slow.resolve(1)
      await run
    })

    expect(commit).toHaveBeenCalledTimes(1)
    const results = commit.mock.calls[0][0]
    expect(results.map((entry) => entry.item.id)).toEqual(['slow', 'fast'])
    expect(results.map((entry) => entry.result)).toEqual([1, 2])
  })

  it('clears the batch state and rethrows when commit fails', async () => {
    const failure = new Error('write failed')
    const runOne = vi.fn(async () => 'done')
    const commit = vi.fn(async () => {
      throw failure
    })
    const { result } = renderHook(() => useBatchTest<{ id: string }, string>({ runOne, commit }))

    await act(async () => {
      const run = result.current.runBatch([{ id: 'a' }])
      await expect(run).rejects.toThrow('write failed')
    })

    expect(result.current.batch).toBeNull()
    expect(result.current.runningIds).toEqual([])
  })

  it('clears the batch state and rethrows when prepare fails', async () => {
    const failure = new Error('no clip')
    const prepare = vi.fn(async () => {
      throw failure
    })
    const runOne = vi.fn(async (_item: { id: string }, prepared: string) => prepared)
    const commit = vi.fn(async () => {})
    const { result } = renderHook(() => useBatchTest<{ id: string }, string, string>({ prepare, runOne, commit }))

    await act(async () => {
      const run = result.current.runBatch([{ id: 'a' }])
      await expect(run).rejects.toThrow('no clip')
    })

    expect(runOne).not.toHaveBeenCalled()
    expect(result.current.batch).toBeNull()
    expect(result.current.runningIds).toEqual([])
  })

  it('clears the batch state and rethrows when a run fails', async () => {
    const failure = new Error('request failed')
    const runOne = vi.fn(async (item: { id: string }) => {
      if (item.id === 'a') throw failure
      return 'done'
    })
    const commit = vi.fn(async () => {})
    const { result } = renderHook(() => useBatchTest<{ id: string }, string>({ runOne, commit }))

    await act(async () => {
      const run = result.current.runBatch([{ id: 'a' }])
      await expect(run).rejects.toThrow('request failed')
    })

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.batch).toBeNull()
    expect(result.current.runningIds).toEqual([])
  })

  it('ignores a late run that finishes after another run failed', async () => {
    const failure = new Error('request failed')
    const slow = deferred<string>()
    const runOne = vi.fn(async (item: { id: string }) => {
      if (item.id === 'a') throw failure
      return slow.promise
    })
    const commit = vi.fn(async () => {})
    const { result } = renderHook(() => useBatchTest<{ id: string }, string>({ runOne, commit }))

    await act(async () => {
      const run = result.current.runBatch([{ id: 'a' }, { id: 'b' }])
      await expect(run).rejects.toThrow('request failed')
    })

    expect(result.current.batch).toBeNull()
    expect(result.current.runningIds).toEqual([])

    await act(async () => {
      slow.resolve('late')
    })

    expect(commit).not.toHaveBeenCalled()
    expect(result.current.batch).toBeNull()
    expect(result.current.runningIds).toEqual([])
  })
})

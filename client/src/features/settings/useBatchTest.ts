// Shared batch runner for the "test all" actions of the AI and ASR profile lists.
//
// Both sections used to hand-roll the same state machine: publish a {done, total}
// progress object, track which profiles are currently testing, run every item
// concurrently, and only clear the state after the checks have been persisted.
// The shared invariant that matters for callers: `batch` stays non-null (keeping
// their `busy` flag on) until `commit` has finished, so a persist failure cannot
// leave the page looking idle while it is still writing.

import { useState } from 'react'

export interface BatchProgress {
  done: number
  total: number
}

export interface BatchRunResult<T, R> {
  item: T
  result: R
}

export interface BatchTestOptions<T, R, P = undefined> {
  /**
   * Runs once before the items and its value is passed to every `runOne` call —
   * for resources that are expensive to prepare and safe to share (e.g. the
   * encoded test clip). The batch state is already visible while it runs.
   */
  prepare?: () => Promise<P>
  runOne: (item: T, prepared: P) => Promise<R>
  /**
   * Receives the results in input order after every run has finished. Called
   * before the batch state is cleared, so callers can persist checks and post
   * their summary notice while the page is still marked busy.
   */
  commit?: (results: BatchRunResult<T, R>[]) => Promise<void> | void
}

export interface BatchTest<T> {
  batch: BatchProgress | null
  runningIds: string[]
  isRunning: (id: string) => boolean
  runBatch: (items: T[]) => Promise<void>
}

export function useBatchTest<T extends { id: string }, R, P = undefined>(
  options: BatchTestOptions<T, R, P>,
): BatchTest<T> {
  const [batch, setBatch] = useState<BatchProgress | null>(null)
  const [runningIds, setRunningIds] = useState<string[]>([])

  async function runBatch(items: T[]): Promise<void> {
    const { prepare, runOne, commit } = options
    setBatch({ done: 0, total: items.length })
    setRunningIds(items.map((item) => item.id))
    let failed = false
    try {
      const prepared = prepare ? await prepare() : (undefined as P)
      let done = 0
      const results = await Promise.all(items.map(async (item) => {
        const result = await runOne(item, prepared)
        // A failed sibling already cleaned the batch up; a late result must not
        // resurrect the progress state after the failure was reported.
        if (failed) return { item, result }
        done += 1
        setBatch({ done, total: items.length })
        setRunningIds((prev) => prev.filter((id) => id !== item.id))
        return { item, result }
      }))
      if (commit) await commit(results)
    } catch (error) {
      failed = true
      throw error
    } finally {
      setRunningIds([])
      setBatch(null)
    }
  }

  return {
    batch,
    runningIds,
    isRunning: (id: string) => runningIds.includes(id),
    runBatch,
  }
}

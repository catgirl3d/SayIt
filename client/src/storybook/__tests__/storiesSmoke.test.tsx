// @vitest-environment jsdom
import { setProjectAnnotations, composeStories } from '@storybook/react-vite'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import * as previewAnnotations from '../../../.storybook/preview'
import {
  cleanupTauriStory,
  drainStoryDeferredWork,
  getTauriJournal,
} from '../tauriMock'

const storyImporters = {
  ...import.meta.glob('../../**/*.stories.tsx'),
  ...import.meta.glob('../../**/*.stories.ts'),
}
type StoryModule = Parameters<typeof composeStories>[0]
type RunnableStory = { run: () => Promise<void> }

expect(Object.keys(storyImporters).length).toBeGreaterThan(0)
setProjectAnnotations(previewAnnotations)

const importedStories = await Promise.all(
  Object.entries(storyImporters).map(async ([path, importer]) => {
    try {
      return { path, module: await importer() as StoryModule, error: undefined }
    } catch (error) {
      return { path, module: undefined, error }
    }
  }),
)

describe('portable Storybook stories', () => {
  afterEach(() => {
    cleanupTauriStory()
  })

  afterAll(async () => {
    // The last story has no next beforeEach to merge its draining delta: flush deferred
    // work and assert the draining journal so late violations cannot slip past the suite.
    await drainStoryDeferredWork()
    const journal = getTauriJournal()
    expect(journal.unknownCommands).toEqual([])
    expect(journal.fetchViolations).toEqual([])
  })

  for (const { path, module, error } of importedStories) {
    if (error || !module) {
      it(`${path} :: module import`, () => {
        throw error
      })
      continue
    }

    let stories: Record<string, unknown>
    try {
      stories = composeStories(module)
    } catch (compositionError) {
      it(`${path} :: composition`, () => {
        throw compositionError
      })
      continue
    }
    if (Object.keys(stories).length === 0) {
      // A module that composes to zero stories would otherwise shrink coverage silently.
      it(`${path} :: no stories composed`, () => {
        throw new Error(`Story module ${path} composed to zero stories`)
      })
      continue
    }
    for (const [exportName, story] of Object.entries(stories)) {
      it(`${path} :: ${exportName}`, async () => {
        let runError: unknown
        let didRunError = false
        try {
          await (story as RunnableStory).run()
        } catch (error) {
          didRunError = true
          runError = error
        } finally {
          cleanupTauriStory()
        }
        // Flush deferred work before reading the journal so cleanup-time violations are
        // asserted by this story instead of leaking into the next one.
        await drainStoryDeferredWork()

        const journal = getTauriJournal()
        expect(journal.unknownCommands).toEqual([])
        expect(journal.fetchViolations).toEqual([])
        if (didRunError) throw runError
      })
    }
  }
})

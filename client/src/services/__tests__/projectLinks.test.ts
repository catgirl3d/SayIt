import { describe, expect, it } from 'vitest'
import { PROJECT_BUG_REPORT_URL, PROJECT_RELEASES_URL, PROJECT_REPOSITORY_URL } from '../projectLinks'

describe('project links', () => {
  it('exports the repository, releases, and bug-report URLs as one related set', () => {
    expect(PROJECT_REPOSITORY_URL).toBe('https://github.com/catgirl3d/SayIt')
    expect(PROJECT_RELEASES_URL).toBe(`${PROJECT_REPOSITORY_URL}/releases`)
    expect(PROJECT_BUG_REPORT_URL).toBe(`${PROJECT_REPOSITORY_URL}/issues/new?template=bug-report.yml`)
  })
})

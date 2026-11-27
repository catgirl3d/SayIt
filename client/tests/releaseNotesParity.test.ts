import { describe, expect, it } from 'vitest'
import { extractReleaseNotes } from '../scripts/extract-release-notes.mjs'
import { buildReleaseNotesHistory } from '@/features/update/changelogHistory'
import { scanChangelogSections } from '@/features/update/releaseNotes'

// The release script and the client parse the same changelog independently. These
// contracts keep their section boundaries and heading normalization byte-identical.
const CRLF_CHANGELOG = [
  '# SayIt (Fork Changelog)',
  '',
  '## v0.3.0 (unreleased)',
  '',
  '- Draft note.',
  '',
  '## v0.2.1 — 2026-10-11',
  '',
  '### Features and Improvements',
  '',
  '- Old thing B.',
  '',
  '## v0.2.0 — 2026-09-01',
  '',
  '- Older thing.',
  '',
].join('\r\n')

describe('release notes parity between the release script and the client', () => {
  it('normalizes CRLF, surrounding blank lines, and a date suffix identically', () => {
    const expected = '## v0.2.1\n\n### Features and Improvements\n\n- Old thing B.'
    const fromScript = extractReleaseNotes(CRLF_CHANGELOG, '0.2.1')
    const fromClient = buildReleaseNotesHistory(
      { en: CRLF_CHANGELOG, uk: '' },
      'en',
      null,
    ).find((entry) => entry.version === '0.2.1')?.notes

    expect(fromScript).toBe(expected)
    expect(fromClient).toBe(expected)
  })

  it('does not open a version section from malformed headings', () => {
    const malformedHeadings = ['## v0.4.0-rc1', '## v0.4.0.1', '#### v0.4.0 notes']

    for (const heading of malformedHeadings) {
      const fixture = `${heading}\n\n- Note.\n`

      expect(scanChangelogSections(fixture).map((section) => section.version), heading).toEqual([])
      expect(
        buildReleaseNotesHistory({ en: fixture, uk: '' }, 'en', null).map(
          (entry) => entry.version,
        ),
        heading,
      ).toEqual([])
      expect(() => extractReleaseNotes(fixture, '0.4.0'), heading).toThrow(
        /has no section for version 0\.4\.0/,
      )
    }
  })

  it('ends a section at the next valid heading, including an unreleased one', () => {
    const fixture = [
      '## v0.3.1 — 2026-10-17',
      '',
      '### Fixed',
      '',
      '- Kept release note.',
      '',
      '## v0.3.2 (unreleased)',
      '',
      '### Added',
      '',
      '- Draft note that must not leak.',
      '',
      '## v0.3.0 — 2026-10-01',
      '',
      '### Added',
      '',
      '- Older note.',
      '',
    ].join('\n')

    expect(scanChangelogSections(fixture).map((section) => [section.version, section.body])).toEqual(
      [
        ['0.3.1', '### Fixed\n\n- Kept release note.'],
        ['0.3.2', '### Added\n\n- Draft note that must not leak.'],
        ['0.3.0', '### Added\n\n- Older note.'],
      ],
    )

    expect(extractReleaseNotes(fixture, '0.3.1')).toBe(
      '## v0.3.1\n\n### Fixed\n\n- Kept release note.',
    )
    expect(extractReleaseNotes(fixture, '0.3.0')).toBe(
      '## v0.3.0\n\n### Added\n\n- Older note.',
    )

    const history = buildReleaseNotesHistory({ en: fixture, uk: '' }, 'en', null)
    expect(history.map((entry) => entry.version).sort()).toEqual(['0.3.0', '0.3.1'])
    expect(history.find((entry) => entry.version === '0.3.1')?.notes).toBe(
      '## v0.3.1\n\n### Fixed\n\n- Kept release note.',
    )
  })
})

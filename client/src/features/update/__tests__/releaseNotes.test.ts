import { describe, expect, it } from 'vitest'
import {
  isUnreleasedSection,
  parseReleaseNotes,
  pickReleaseNotes,
  scanChangelogSections,
} from '../releaseNotes'

const SECTION = `## v0.2.2

### Features and Improvements

#### Computer subtitles

- Added live captions.
- Fixed a stall.

### Reliability and Build

- Added regression coverage.
`

describe('parseReleaseNotes', () => {
  it('parses the changelog section shape into headings and bullets', () => {
    expect(parseReleaseNotes(SECTION)).toEqual([
      { kind: 'heading', level: 3, text: 'Features and Improvements' },
      { kind: 'heading', level: 4, text: 'Computer subtitles' },
      { kind: 'bullet', text: 'Added live captions.' },
      { kind: 'bullet', text: 'Fixed a stall.' },
      { kind: 'heading', level: 3, text: 'Reliability and Build' },
      { kind: 'bullet', text: 'Added regression coverage.' },
    ])
  })

  it('skips the section title the page renders itself', () => {
    expect(parseReleaseNotes('## v0.2.2\n\n- One thing\n')).toEqual([
      { kind: 'bullet', text: 'One thing' },
    ])
  })

  it('keeps unknown lines as paragraphs', () => {
    expect(parseReleaseNotes('Plain line.\n- Bullet.\n')).toEqual([
      { kind: 'paragraph', text: 'Plain line.' },
      { kind: 'bullet', text: 'Bullet.' },
    ])
  })

  it('handles CRLF and blank lines', () => {
    expect(parseReleaseNotes('## v0.2.2\r\n\r\n### Section\r\n\r\n- A\r\n')).toEqual([
      { kind: 'heading', level: 3, text: 'Section' },
      { kind: 'bullet', text: 'A' },
    ])
  })

  it('returns no blocks for empty or whitespace input', () => {
    expect(parseReleaseNotes('')).toEqual([])
    expect(parseReleaseNotes('  \n\n  ')).toEqual([])
  })
})

describe('scanChangelogSections', () => {
  it('splits multiple released sections and keeps the date suffix', () => {
    const markdown = `# SayIt Changelog

Intro text.

## v0.4.0 — 2026-11-26

- Newest release.

## v0.3.1 — 2026-10-01

### Fixed

- Older release.
`

    expect(scanChangelogSections(markdown)).toEqual([
      { version: '0.4.0', suffix: '— 2026-11-26', body: '- Newest release.' },
      { version: '0.3.1', suffix: '— 2026-10-01', body: '### Fixed\n\n- Older release.' },
    ])
  })

  it('handles CRLF and keeps non-version headings in the body', () => {
    const markdown =
      '# Changelog\r\n\r\n## v0.2.0 — 2026-01-02\r\n\r\n### Added\r\n\r\n- A\r\n\r\n## Notes\r\n\r\nPlain.\r\n'

    expect(scanChangelogSections(markdown)).toEqual([
      {
        version: '0.2.0',
        suffix: '— 2026-01-02',
        body: '### Added\n\n- A\n\n## Notes\n\nPlain.',
      },
    ])
  })

  it('does not leak an unreleased body into adjacent released sections', () => {
    const markdown = `## v0.4.0 — 2026-11-26

- Released four.

## v0.4.1 (unreleased)

- Draft only.

## v0.3.9 — 2026-10-01

- Released three.
`
    const sections = scanChangelogSections(markdown)

    expect(sections.map((section) => section.version)).toEqual(['0.4.0', '0.4.1', '0.3.9'])
    expect(sections[0].body).toBe('- Released four.')
    expect(sections[1].body).toBe('- Draft only.')
    expect(sections[2].body).toBe('- Released three.')
    expect(isUnreleasedSection(sections[1])).toBe(true)
    expect(isUnreleasedSection(sections[0])).toBe(false)
    expect(sections[1].suffix).toBe('(unreleased)')
  })

  it('treats malformed version headings as body text', () => {
    const markdown = `## v0.3.0

Body.

## v0.2.2.1

Not a section.

## v0.2.2-rc1

Also not.

## v0.2.2

Old.
`
    const sections = scanChangelogSections(markdown)

    expect(sections.map((section) => section.version)).toEqual(['0.3.0', '0.2.2'])
    expect(sections[0].body).toContain('## v0.2.2.1')
    expect(sections[0].body).toContain('## v0.2.2-rc1')
    expect(sections[1].body).toBe('Old.')
  })

  it('trims bodies and keeps heading-only sections as empty', () => {
    expect(scanChangelogSections('\n\n## v1.0.0\n\n\n- A\n\n\n## v0.9.0\n\n\n')).toEqual([
      { version: '1.0.0', suffix: '', body: '- A' },
      { version: '0.9.0', suffix: '', body: '' },
    ])
  })

  it('recognizes the unreleased suffix case-insensitively', () => {
    expect(isUnreleasedSection({ version: '1.0.0', suffix: '(UNRELEASED)', body: '' })).toBe(true)
    expect(isUnreleasedSection({ version: '1.0.0', suffix: '(Unreleased)', body: '' })).toBe(true)
    expect(isUnreleasedSection({ version: '1.0.0', suffix: '— 2026-01-01', body: '' })).toBe(false)
  })
})

describe('pickReleaseNotes', () => {
  it('prefers the translation for the active locale', () => {
    expect(pickReleaseNotes('base', { uk: 'uk-text' }, 'uk')).toBe('uk-text')
  })

  it('falls back to the base notes when the locale has no translation', () => {
    expect(pickReleaseNotes('base', { uk: 'uk-text' }, 'en')).toBe('base')
    expect(pickReleaseNotes('base', null, 'uk')).toBe('base')
  })

  it('does not treat a blank translation as present', () => {
    expect(pickReleaseNotes('base', { uk: '   ' }, 'uk')).toBe('base')
  })

  it('prefers the translation even when there are no base notes', () => {
    expect(pickReleaseNotes(null, { uk: 'uk-text' }, 'uk')).toBe('uk-text')
  })

  it('returns null when neither source exists', () => {
    expect(pickReleaseNotes(null, null, 'uk')).toBeNull()
    expect(pickReleaseNotes(null, { uk: 'uk-text' }, 'en')).toBeNull()
  })
})

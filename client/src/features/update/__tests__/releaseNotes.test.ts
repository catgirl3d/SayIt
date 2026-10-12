import { describe, expect, it } from 'vitest'
import { parseReleaseNotes } from '../releaseNotes'

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

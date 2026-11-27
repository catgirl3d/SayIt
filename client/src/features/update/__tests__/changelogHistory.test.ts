import { describe, expect, it } from 'vitest'
import {
  buildReleaseNotesHistory,
  formatReleaseDate,
  getReleaseNotesHistory,
  pinReleaseNotesVersion,
  resolveShownVersion,
  type PinnedReleaseNotesVersion,
} from '../changelogHistory'
import { parseReleaseNotes } from '../releaseNotes'

const EN = `# SayIt Changelog

## v0.4.0 — 2026-11-26

- English four.

## v0.3.0 — 2026-10-01

- English three.

## v0.2.0 — 2026-09-01

- English two.
`

const UK_IN_REVERSE_ORDER = `# Журнал змін

## v0.2.0 — 2026-09-01

- Українська два.

## v0.4.0 — 2026-11-26

- Українська чотири.
`

function bulletTexts(notes: string): string[] {
  return parseReleaseNotes(notes)
    .filter((block) => block.kind === 'bullet')
    .map((block) => block.text)
}

describe('buildReleaseNotesHistory', () => {
  it('joins Ukrainian notes by version and falls back to English per version', () => {
    const versions = buildReleaseNotesHistory(
      { en: EN, uk: UK_IN_REVERSE_ORDER },
      'uk',
      null,
    )

    expect(versions.map((entry) => entry.version)).toEqual(['0.4.0', '0.3.0', '0.2.0'])
    expect(bulletTexts(versions[0].notes)).toEqual(['Українська чотири.'])
    expect(bulletTexts(versions[1].notes)).toEqual(['English three.'])
    expect(bulletTexts(versions[2].notes)).toEqual(['Українська два.'])
  })

  it('uses English notes for any locale other than uk', () => {
    const versions = buildReleaseNotesHistory(
      { en: EN, uk: UK_IN_REVERSE_ORDER },
      'de',
      null,
    )

    expect(versions.map((entry) => entry.version)).toEqual(['0.4.0', '0.3.0', '0.2.0'])
    expect(bulletTexts(versions[0].notes)).toEqual(['English four.'])
  })

  it('excludes unreleased sections', () => {
    const en = `## v0.4.1 (unreleased)

- Draft only.

## v0.4.0 — 2026-11-26

- Released.
`
    const uk = `## v0.4.1 (unreleased)

- Чернетка.

## v0.4.0 — 2026-11-26

- Випущено.
`

    const versions = buildReleaseNotesHistory({ en, uk }, 'uk', null)

    expect(versions.map((entry) => entry.version)).toEqual(['0.4.0'])
    expect(bulletTexts(versions[0].notes)).toEqual(['Випущено.'])
  })

  it('excludes heading-only and blank sections', () => {
    const en = `## v0.5.0

## v0.4.9

   

## v0.4.0 — 2026-11-26

- Real notes.
`

    expect(buildReleaseNotesHistory({ en, uk: '' }, 'en', null)).toEqual([
      { version: '0.4.0', notes: '## v0.4.0\n\n- Real notes.', date: '2026-11-26' },
    ])
  })

  it('takes each date from the English heading and leaves an undated heading null', () => {
    const en = `## v0.4.0 — 2026-11-26

- Dated.

## v0.3.0

- Undated.

## v0.2.0 — 2026-13-40

- Impossible date.
`
    const uk = `## v0.4.0 — 2026-01-01

- Датовано.
`

    const versions = buildReleaseNotesHistory({ en, uk }, 'uk', null)

    expect(versions.map((entry) => [entry.version, entry.date])).toEqual([
      ['0.4.0', '2026-11-26'],
      ['0.3.0', null],
      ['0.2.0', null],
    ])
    expect(bulletTexts(versions[0].notes)).toEqual(['Датовано.'])
  })

  it('sorts numerically, newest first', () => {
    const en = `## v1.9.0

- Nine.

## v1.10.0

- Ten.

## v1.2.0

- Two.
`

    expect(
      buildReleaseNotesHistory({ en, uk: '' }, 'en', null).map((entry) => entry.version),
    ).toEqual(['1.10.0', '1.9.0', '1.2.0'])
  })

  it('dedupes duplicate versions and lets a displayable duplicate count', () => {
    const duplicate = `## v0.4.0

- First.

## v0.4.0

- Second.
`
    const blankThenDisplayable = `## v0.4.0

## v0.4.0

- Later.
`

    const versions = buildReleaseNotesHistory({ en: duplicate, uk: '' }, 'en', null)
    const recovered = buildReleaseNotesHistory({ en: blankThenDisplayable, uk: '' }, 'en', null)

    expect(versions).toHaveLength(1)
    expect(bulletTexts(versions[0].notes)).toEqual(['First.'])
    expect(recovered).toHaveLength(1)
    expect(bulletTexts(recovered[0].notes)).toEqual(['Later.'])
  })

  it('adds a manifest version that the bundle does not contain', () => {
    const en = '## v0.4.0 — 2026-11-26\n\n- Bundled.\n'

    const versions = buildReleaseNotesHistory({ en, uk: '' }, 'en', {
      version: '0.5.0',
      notes: '- Manifest notes.',
      releaseDate: '2026-12-03T23:30:00.000Z',
    })

    expect(versions.map((entry) => entry.version)).toEqual(['0.5.0', '0.4.0'])
    expect(bulletTexts(versions[0].notes)).toEqual(['Manifest notes.'])
    // The UTC day of the publish moment, regardless of the machine's timezone.
    expect(versions[0].date).toBe('2026-12-03')
  })

  it('leaves a manifest-only version undated when the manifest has no release date', () => {
    const versions = buildReleaseNotesHistory({ en: '', uk: '' }, 'en', {
      version: '0.5.0',
      notes: '- Manifest notes.',
      releaseDate: null,
    })

    expect(versions).toEqual([{ version: '0.5.0', notes: '- Manifest notes.', date: null }])
  })

  it('lets manifest notes win for the same version', () => {
    const en = '## v0.4.0 — 2026-11-26\n\n- Bundled.\n'

    const versions = buildReleaseNotesHistory({ en, uk: '' }, 'en', {
      version: '0.4.0',
      notes: '- Manifest override.',
      releaseDate: '2026-11-27T00:30:00.000Z',
    })

    expect(versions).toHaveLength(1)
    expect(bulletTexts(versions[0].notes)).toEqual(['Manifest override.'])
    // The heading's release day wins over the later publish moment.
    expect(versions[0].date).toBe('2026-11-26')
  })

  it('does not add or remove anything when manifest notes are absent or blank', () => {
    const en = '## v0.4.0 — 2026-11-26\n\n- Bundled.\n'

    const withoutNotes = buildReleaseNotesHistory({ en, uk: '' }, 'en', {
      version: '0.9.9',
      notes: null,
      releaseDate: '2026-12-03T12:00:00.000Z',
    })
    const blankNotes = buildReleaseNotesHistory({ en, uk: '' }, 'en', {
      version: '0.4.0',
      notes: '   ',
      releaseDate: null,
    })

    expect(withoutNotes.map((entry) => entry.version)).toEqual(['0.4.0'])
    expect(blankNotes.map((entry) => entry.version)).toEqual(['0.4.0'])
    expect(bulletTexts(blankNotes[0].notes)).toEqual(['Bundled.'])
  })
})

describe('pinReleaseNotesVersion', () => {
  const versions = [
    { version: '0.4.0', notes: '- Four.', date: '2026-11-26' },
    { version: '0.2.0', notes: '- Two.', date: null },
  ]
  const pinned: PinnedReleaseNotesVersion = {
    version: '0.3.0',
    notes: '- Pinned three.',
    date: '2026-10-17',
    locale: 'en',
  }

  it('leaves the history unchanged without a pin', () => {
    expect(pinReleaseNotesVersion(versions, null, 'en')).toBe(versions)
  })

  it('does not reuse a snapshot from another locale', () => {
    expect(
      pinReleaseNotesVersion(versions, { ...pinned, locale: 'uk' }, 'en'),
    ).toBe(versions)
  })

  it('lets the live entry win over a snapshot of the same version', () => {
    expect(
      pinReleaseNotesVersion(versions, { ...pinned, version: '0.4.0' }, 'en'),
    ).toBe(versions)
  })

  it('inserts a missing pinned version and sorts it newest first', () => {
    const result = pinReleaseNotesVersion(versions, pinned, 'en')

    // The snapshot keeps its date; the locale tag stays out of the history entry.
    expect(result).toEqual([
      { version: '0.4.0', notes: '- Four.', date: '2026-11-26' },
      { version: '0.3.0', notes: '- Pinned three.', date: '2026-10-17' },
      { version: '0.2.0', notes: '- Two.', date: null },
    ])
    expect(versions).toHaveLength(2)
  })
})

describe('resolveShownVersion', () => {
  const versions = [
    { version: '0.4.0', notes: '- Four.', date: null },
    { version: '0.3.0', notes: '- Three.', date: null },
  ]

  it('prefers the picked version, then the manifest, then the current version', () => {
    expect(resolveShownVersion('0.3.0', '0.4.0', '0.2.0', versions)).toBe('0.3.0')
    expect(resolveShownVersion(null, '0.4.0', '0.2.0', versions)).toBe('0.4.0')
    expect(resolveShownVersion(null, null, '0.3.0', versions)).toBe('0.3.0')
  })

  it('falls back from a stale pick to the next available candidate', () => {
    expect(resolveShownVersion('9.9.9', '0.4.0', '0.2.0', versions)).toBe('0.4.0')
    expect(resolveShownVersion('9.9.9', '8.8.8', '0.3.0', versions)).toBe('0.3.0')
    expect(resolveShownVersion('9.9.9', '8.8.8', '7.7.7', versions)).toBe('0.4.0')
  })

  it('prefers the installed version over a newer bundled one on an offline first render', () => {
    expect(resolveShownVersion(null, null, '0.3.0', versions)).toBe('0.3.0')
  })

  it('keeps the installed version over a stale manifest default', () => {
    expect(resolveShownVersion(null, '0.3.0', '0.4.0', versions)).toBe('0.4.0')
  })

  it('still honors an explicit pick when the manifest is stale', () => {
    expect(resolveShownVersion('0.3.0', '0.3.0', '0.4.0', versions)).toBe('0.3.0')
  })

  it('lets a newer manifest win over the installed version', () => {
    const withNewer = [{ version: '0.5.0', notes: '- Five.', date: null }, ...versions]

    expect(resolveShownVersion(null, '0.5.0', '0.4.0', withNewer)).toBe('0.5.0')
  })

  it('returns null when nothing is displayable', () => {
    expect(resolveShownVersion('0.4.0', '0.4.0', '0.4.0', [])).toBeNull()
  })
})

describe('getReleaseNotesHistory bundled data', () => {
  it('parses at least one release from the real English changelog', () => {
    const versions = getReleaseNotesHistory('en', null)

    expect(versions.length).toBeGreaterThan(0)
    for (const entry of versions) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(parseReleaseNotes(entry.notes).length).toBeGreaterThan(0)
    }
  })

  it('uses the real Ukrainian sections for the Ukrainian history', () => {
    const english = getReleaseNotesHistory('en', null)
    const ukrainian = getReleaseNotesHistory('uk', null)

    expect(ukrainian.map((entry) => entry.version)).toEqual(
      english.map((entry) => entry.version),
    )
    expect(ukrainian.some((entry) => /[А-Яа-яІіЇїЄєҐґ]/.test(entry.notes))).toBe(true)
  })

  it('dates the real releases from their changelog headings', () => {
    const versions = getReleaseNotesHistory('uk', null)

    expect(versions.find((entry) => entry.version === '0.4.0')?.date).toBe('2026-11-26')
    for (const entry of versions) {
      expect(entry.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('formatReleaseDate', () => {
  it('formats a calendar day numerically for the interface locale', () => {
    expect(formatReleaseDate('2026-11-26', 'uk')).toBe('26.11.2026')
    expect(formatReleaseDate('2026-11-26', 'en')).toBe('11/26/2026')
  })

  it('keeps the first day of a month on that day instead of shifting it by timezone', () => {
    expect(formatReleaseDate('2026-01-01', 'uk')).toBe('01.01.2026')
  })
})

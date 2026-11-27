import changelogEn from '../../../../CHANGELOG.md?raw'
import changelogUk from '../../../../CHANGELOG.uk.md?raw'
import { isUnreleasedSection, parseReleaseNotes, scanChangelogSections } from './releaseNotes'
import { compareVersions } from './updateChecker'

export interface ReleaseNotesVersion {
  version: string
  notes: string
  /** Release day as an ISO calendar date (YYYY-MM-DD), or null when no source states one. */
  date: string | null
}

/** What the update manifest reports about its own version. Display-only on this page. */
export interface ManifestReleaseNotes {
  version: string
  /** Already localized by the caller. */
  notes: string | null
  /** Publish moment as a UTC ISO timestamp. */
  releaseDate: string | null
}

/**
 * A display-only snapshot of what the user explicitly chose on the About page. It is
 * never a source of updater truth. The interface locale is stored because the notes are
 * already localized, so the snapshot must not cross a locale change.
 */
export interface PinnedReleaseNotesVersion extends ReleaseNotesVersion {
  locale: string
}

function sectionMarkdown(version: string, body: string): string {
  return `## v${version}\n\n${body}`.trim()
}

function hasDisplayableNotes(markdown: string | null | undefined): markdown is string {
  return typeof markdown === 'string' && parseReleaseNotes(markdown).length > 0
}

// Digit lookarounds instead of \b: in a timestamp the day is followed by "T", a word
// character, so a word boundary would never match there.
const CALENDAR_DATE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/

/**
 * The first YYYY-MM-DD in the text, kept only when it names a real day: a UTC round
 * trip rejects values such as "2026-13-40" that Date would silently roll over.
 */
export function parseCalendarDate(text: string): string | null {
  const match = CALENDAR_DATE.exec(text)
  if (match === null) return null
  const [iso, year, month, day] = match
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)))
  return parsed.toISOString().slice(0, 10) === iso ? iso : null
}

interface ReleasedSection {
  notes: string
  date: string | null
}

/**
 * Index released changelog sections by version. A heading-only or blank section is
 * absent, so a malformed first occurrence cannot hide a later displayable one. The date
 * comes from the heading suffix, for example "## v0.4.0 — 2026-11-26".
 */
function releasedSectionsByVersion(markdown: string): Map<string, ReleasedSection> {
  const sectionsByVersion = new Map<string, ReleasedSection>()
  for (const section of scanChangelogSections(markdown)) {
    if (isUnreleasedSection(section)) continue
    if (sectionsByVersion.has(section.version)) continue
    const notes = sectionMarkdown(section.version, section.body)
    if (!hasDisplayableNotes(notes)) continue
    sectionsByVersion.set(section.version, { notes, date: parseCalendarDate(section.suffix) })
  }
  return sectionsByVersion
}

/**
 * Format an ISO calendar date for the interface locale, e.g. "26.11.2026" for uk. The
 * date is built and formatted in UTC: it names a day, not a moment, and formatting it in
 * local time would show the previous day west of UTC.
 */
export function formatReleaseDate(date: string, locale: string): string {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Build the version history shown on the About page from the bundled changelogs.
 *
 * The English file defines which versions exist. Ukrainian notes are joined by version,
 * never by array position; a missing or blank UK section falls back to English and never
 * removes the version. The manifest may override or add notes for its exact version,
 * because those notes came from the release itself and are already localized by the
 * caller. A manifest without displayable notes changes nothing here: this function is
 * display-only and must not affect the updater's view of what is available.
 *
 * Dates come from the English headings, which define the versions. A bundled version
 * keeps its heading date even when the manifest overrides its notes: the heading is the
 * documented release day, while the manifest's releaseDate is the later publish moment
 * and may fall on the next day. The manifest date is used only for a version the bundle
 * does not contain, and its UTC day keeps this function independent of the timezone.
 */
export function buildReleaseNotesHistory(
  sources: { en: string; uk: string },
  locale: string,
  manifest: ManifestReleaseNotes | null,
): ReleaseNotesVersion[] {
  const englishSections = releasedSectionsByVersion(sources.en)
  const ukrainianSections = locale === 'uk' ? releasedSectionsByVersion(sources.uk) : null

  const byVersion = new Map<string, ReleaseNotesVersion>()
  for (const [version, { notes, date }] of englishSections) {
    byVersion.set(version, {
      version,
      notes: ukrainianSections?.get(version)?.notes ?? notes,
      date,
    })
  }

  if (manifest !== null && manifest.version && hasDisplayableNotes(manifest.notes)) {
    const bundledDate = byVersion.get(manifest.version)?.date ?? null
    byVersion.set(manifest.version, {
      version: manifest.version,
      notes: manifest.notes,
      date: bundledDate ?? parseCalendarDate(manifest.releaseDate ?? ''),
    })
  }

  return [...byVersion.values()].sort((left, right) =>
    compareVersions(left.version, right.version),
  )
}

/**
 * Keep an explicit user selection visible even when a later manifest refresh no longer
 * describes it. The live history always wins for the same version, so a locale change or
 * a manifest override is shown instead of the snapshot. A snapshot from another locale
 * must not be reused because its notes are already localized.
 */
export function pinReleaseNotesVersion(
  versions: ReleaseNotesVersion[],
  pinned: PinnedReleaseNotesVersion | null,
  locale: string,
): ReleaseNotesVersion[] {
  if (pinned === null || pinned.locale !== locale) return versions
  if (versions.some((entry) => entry.version === pinned.version)) return versions

  const snapshot = { version: pinned.version, notes: pinned.notes, date: pinned.date }
  return [...versions, snapshot].sort((left, right) =>
    compareVersions(left.version, right.version),
  )
}

export function resolveShownVersion(
  pickedVersion: string | null,
  manifestVersion: string | null,
  currentVersion: string,
  versions: ReadonlyArray<ReleaseNotesVersion>,
): string | null {
  const hasVersion = (candidate: string | null): candidate is string =>
    candidate !== null && versions.some((entry) => entry.version === candidate)

  if (hasVersion(pickedVersion)) return pickedVersion

  // A stale manifest (older than the installed version) must not replace the notes of
  // the version the user is actually running. compareVersions(manifest, installed) > 0
  // means the installed version is newer. A newer or equal manifest keeps its precedence.
  const manifestIsStale =
    manifestVersion !== null &&
    hasVersion(currentVersion) &&
    compareVersions(manifestVersion, currentVersion) > 0
  if (hasVersion(manifestVersion) && !manifestIsStale) return manifestVersion

  if (hasVersion(currentVersion)) return currentVersion
  return versions[0]?.version ?? null
}

export function getReleaseNotesHistory(
  locale: string,
  manifest: ManifestReleaseNotes | null,
): ReleaseNotesVersion[] {
  return buildReleaseNotesHistory({ en: changelogEn, uk: changelogUk }, locale, manifest)
}

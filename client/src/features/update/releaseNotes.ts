/**
 * Release notes travel inside the update manifest: the manifest carries the
 * CHANGELOG.md section of the released version, so the About page can show the
 * real notes at the moment an update is found — no second request, no hand-written
 * highlight list. Localized sections (CHANGELOG.uk.md) ship in the same manifest
 * from the same commit, so a translation can never describe content other than the
 * source section it mirrors.
 *
 * The text is Markdown by origin, but only the small subset the changelog actually
 * uses is recognized: '####' and '###' headings and '- ' bullets. The top-level
 * '## vX.Y.Z' heading is skipped because the page renders its own title, and any
 * other line stays a paragraph. Parsing this here keeps a Markdown renderer and its
 * sanitizer out of the bundle for text this repository generates itself.
 */
export type ReleaseNoteBlock =
  | { kind: 'heading'; level: 3 | 4; text: string }
  | { kind: 'bullet'; text: string }
  | { kind: 'paragraph'; text: string }

export interface ChangelogSection {
  version: string
  /** The rest of the heading line after the version, for example "— 2026-11-26" or "(unreleased)". */
  suffix: string
  /** Trimmed Markdown between this version heading and the next one. */
  body: string
}

/**
 * The same rule as the release script (client/scripts/extract-release-notes.mjs):
 * exactly two hashes, numeric major.minor.patch, and the version must end the token so
 * malformed headings such as "## v0.2.2.1" or "## v0.2.2-rc1" are not version sections.
 */
const VERSION_HEADING = /^## v(\d+\.\d+\.\d+)(?=\s|$)/

/**
 * Split a changelog into its version sections. Every recognized version heading starts
 * a new section first, so the body of a draft "(unreleased)" section can never leak into
 * the released section above or below it. Other "## ..." headings stay inside the body;
 * the changelog renderer skips them separately.
 */
export function scanChangelogSections(markdown: string): ChangelogSection[] {
  const sections: ChangelogSection[] = []
  let current: { version: string; suffix: string; lines: string[] } | null = null

  const flush = () => {
    if (current === null) return
    sections.push({
      version: current.version,
      suffix: current.suffix,
      body: current.lines.join('\n').trim(),
    })
  }

  for (const line of markdown.split(/\r?\n/)) {
    const match = VERSION_HEADING.exec(line)
    if (match !== null) {
      flush()
      current = {
        version: match[1],
        suffix: line.slice(match[0].length).trim(),
        lines: [],
      }
      continue
    }
    if (current !== null) current.lines.push(line)
  }
  flush()
  return sections
}

export function isUnreleasedSection(section: ChangelogSection): boolean {
  return section.suffix.toLowerCase().includes('(unreleased)')
}

/**
 * Pick the notes to show for an interface locale: the translated section when the
 * manifest carries one for that locale, otherwise the base (English) notes. A blank
 * translation is treated as absent, matching the "fall back to the source language"
 * rule of the i18n runtime; when neither source exists the result is null and the
 * About page simply shows no notes block.
 */
export function pickReleaseNotes(
  base: string | null,
  localized: Record<string, string> | null,
  locale: string,
): string | null {
  const translated = localized?.[locale]
  if (typeof translated === 'string' && translated.trim() !== '') return translated
  return base
}

export function parseReleaseNotes(markdown: string): ReleaseNoteBlock[] {
  const blocks: ReleaseNoteBlock[] = []
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '') continue
    if (line.startsWith('#### ')) {
      blocks.push({ kind: 'heading', level: 4, text: line.slice(5).trim() })
      continue
    }
    if (line.startsWith('### ')) {
      blocks.push({ kind: 'heading', level: 3, text: line.slice(4).trim() })
      continue
    }
    if (line.startsWith('## ')) continue
    if (line.startsWith('- ')) {
      blocks.push({ kind: 'bullet', text: line.slice(2).trim() })
      continue
    }
    blocks.push({ kind: 'paragraph', text: line })
  }
  return blocks
}

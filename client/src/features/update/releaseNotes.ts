/**
 * Release notes travel inside the update manifest: the manifest carries the
 * CHANGELOG-FORK.md section of the released version, so the About page can show the
 * real notes at the moment an update is found — no second request, no hand-written
 * highlight list. Localized sections (CHANGELOG-FORK.uk.md) ship in the same manifest
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

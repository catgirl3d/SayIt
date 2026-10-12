/**
 * Release notes travel inside the update manifest: the manifest carries the
 * CHANGELOG-FORK.md section of the released version, so the About page can show the
 * real notes at the moment an update is found — no second request, no hand-written
 * highlight list, no translations that drift from the source.
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

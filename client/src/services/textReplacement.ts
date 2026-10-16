// Text replacement service — client-side rewrites of ASR recognition results

import { getSetting, setSetting } from './store'

export interface TextReplacementRule {
  id: string
  from: string
  to: string
  enabled: boolean
}

const STORAGE_KEY = 'textReplacements'

/** Built-in default replacement rules (shown while the user has none of their own) */
export const BUILTIN_REPLACEMENTS: TextReplacementRule[] = [
  { id: 'builtin_1', from: 'Cloud Code', to: 'Claude Code', enabled: true },
]

export async function getTextReplacements(): Promise<TextReplacementRule[]> {
  const rules = await getSetting<TextReplacementRule[]>(STORAGE_KEY, [])
  // Return the built-in defaults while the user has no rules of their own
  if (!rules || rules.length === 0) {
    return BUILTIN_REPLACEMENTS.map((r) => ({ ...r }))
  }
  return rules
}

export async function saveTextReplacements(rules: TextReplacementRule[]): Promise<void> {
  await setSetting(STORAGE_KEY, rules)
}

/** Rule drafts parsed from batch text (no id/enabled assigned yet) */
export interface ParsedReplacement {
  from: string
  to: string
}

/**
 * Parse pasted batch text into replacement rule drafts.
 * - One rule per line; empty lines are ignored.
 * - Separators: tab (pasted from a spreadsheet), `=>`, `->`, a Chinese comma 「，」, an ASCII comma `,`.
 *   The earliest separator in the line splits it: before it is the "from" side, after it
 *   (including any further separators) is the "to" side.
 * - A line with no separator: the whole line is the "from" side and the replacement is empty
 *   (i.e. the text is deleted).
 * - Lines with an empty "from" side are ignored.
 */
export function parseBatchReplacements(input: string): ParsedReplacement[] {
  const separators = ['\t', '=>', '->', '，', ','] // i18n-allow: Chinese comma as a batch-input separator
  const result: ParsedReplacement[] = []

  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    let sepIndex = -1
    let sepLen = 0
    for (const sep of separators) {
      const i = line.indexOf(sep)
      if (i >= 0 && (sepIndex === -1 || i < sepIndex)) {
        sepIndex = i
        sepLen = sep.length
      }
    }

    let from = line
    let to = ''
    if (sepIndex >= 0) {
      from = line.slice(0, sepIndex).trim()
      to = line.slice(sepIndex + sepLen).trim()
    }

    if (!from) continue
    result.push({ from, to })
  }

  return result
}

/** Apply every enabled replacement rule to the text */
export function applyReplacements(text: string, rules: TextReplacementRule[]): string {
  let result = text
  for (const rule of rules) {
    if (rule.enabled && rule.from) {
      result = result.split(rule.from).join(rule.to)
    }
  }
  return result
}

/** Load the rules and apply them (convenience helper) */
export async function applyTextReplacements(text: string): Promise<string> {
  if (!text) return text
  const rules = await getTextReplacements()
  if (rules.length === 0) return text
  return applyReplacements(text, rules)
}

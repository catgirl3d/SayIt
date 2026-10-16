#!/usr/bin/env node
/**
 * Hardcoded-Chinese scan — the i18n anti-regression gate.
 *
 * Why the gate must exist: during P1 we keep shipping features while
 * translating, so Chinese strings keep arriving. Without this gate the
 * translation work never converges (finish one area — new Chinese lands in
 * another).
 *
 * Why Node instead of .ps1: the script must run in CI and from any shell on
 * any machine; this workstation's PowerShell 5.1 reads UTF-8-without-BOM .ps1
 * files as GBK, so Chinese comments turn into mojibake and become syntax
 * errors (see pitfalls 9). Node always reads files as UTF-8.
 *
 * It reports Chinese in **code** only: comments carry 1700+ lines of Chinese,
 * which is the project's normal style, and dumping all of them would drown
 * the real findings. So comments are stripped first, then what remains is
 * searched.
 *
 * It also validates the active locales (en/uk): no Chinese in values, the
 * same leaf keys on both sides, and identical {placeholder} sets per key.
 *
 * Usage:
 *   node scripts/check-i18n.mjs            # summary of files not yet migrated
 *   node scripts/check-i18n.mjs --all      # list every line
 *   node scripts/check-i18n.mjs --strict   # any finding outside the allowlist exits 1 (CI)
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const SRC_ROOT = fileURLToPath(new URL('../src', import.meta.url))
const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff5e]/

/**
 * Paths allowed to contain Chinese (prefix match, relative to client/).
 *
 * Before adding anything here, ask: is this Chinese **user-facing copy** or
 * **data being processed**? Copy belongs in locale files and must not enter
 * this list.
 */
const ALLOWLIST = [
  // Locale files are where Chinese copy lives.
  'src/i18n/locales/',
]

/**
 * Tests are skipped as a whole.
 *
 * Chinese in tests comes in two kinds, and neither is this script's business:
 * **test data** for Chinese text processing (textPostProcess / textReplacement
 * / textSegmenter — translating it would disable the tests), and Chinese
 * describe/it titles, which are the project's established style rather than
 * user-facing copy. What does need handling are the few tests that assert
 * user-facing copy — those move to key assertions slice by slice under the P1
 * rule "every slice follows the three rules", not through this scan.
 */
const SKIP_DIRS = ['__tests__']

const args = new Set(process.argv.slice(2))
const showAll = args.has('--all')
const strict = args.has('--strict')

/**
 * A few Chinese strings are algorithm inputs, error-match words, or prompts
 * rather than UI copy. They must declare their boundary in place:
 *   // i18n-allow-start: reason
 *   ...
 *   // i18n-allow-end
 * or `// i18n-allow: reason` at the end of a single line.
 *
 * There is no whole-file allowlist: when such a file later gains new UI copy,
 * the gate must still catch it.
 */
function collectAllowedLines(file, source) {
  const allowed = new Set()
  let inAllowedBlock = false
  source.split('\n').forEach((line, index) => {
    const lineNumber = index + 1
    if (line.includes('i18n-allow-start')) {
      if (inAllowedBlock) throw new Error(`${file}:${lineNumber}: nested i18n allow block`)
      inAllowedBlock = true
    }
    if (inAllowedBlock || line.includes('i18n-allow:')) allowed.add(lineNumber)
    if (line.includes('i18n-allow-end')) {
      if (!inAllowedBlock) throw new Error(`${file}:${lineNumber}: unmatched i18n-allow-end`)
      inAllowedBlock = false
    }
  })
  if (inAllowedBlock) throw new Error(`${file}: unclosed i18n allow block`)
  return allowed
}

function isTextBearingNode(node) {
  return ts.isStringLiteralLike(node)
    || ts.isRegularExpressionLiteral(node)
    || ts.isJsxText(node)
    || node.kind === ts.SyntaxKind.TemplateHead
    || node.kind === ts.SyntaxKind.TemplateMiddle
    || node.kind === ts.SyntaxKind.TemplateTail
}

/** Walks the TypeScript AST for strings, templates, regexes, and JSX text; comments never enter the results. */
function findChinese(file, source) {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const sourceLines = source.split('\n')
  const allowedLines = collectAllowedLines(file, source)
  const results = new Map()

  const visit = (node) => {
    if (isTextBearingNode(node)) {
      const nodeText = node.getText(sourceFile)
      const isJsxComment = ts.isJsxText(node) && /^\s*\{\/\*/.test(nodeText)
      if (!isJsxComment && CJK.test(nodeText)) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line
        nodeText.split('\n').forEach((part, offset) => {
          const line = start + offset
          const lineNumber = line + 1
          if (!allowedLines.has(lineNumber) && CJK.test(part)) {
            results.set(lineNumber, { line: lineNumber, text: (sourceLines[line] ?? '').trim() })
          }
        })
      }
    }
    if (!ts.isJsxText(node)) {
      ts.forEachChild(node, visit)
    }
  }
  visit(sourceFile)
  return [...results.values()]
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.includes(entry)) walk(full, files)
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

function isAllowed(relPath) {
  const posix = relPath.split(sep).join('/')
  return ALLOWLIST.some((prefix) => posix.startsWith(prefix))
}

// --- Active locale checks (en/uk) ---

const LOCALE_DIR = 'src/i18n/locales'
const LOCALE_NAMES = ['en.json', 'uk.json']
const PLACEHOLDER = /\{[^}]*\}/g

/** Collect every leaf of a locale table as `path -> value`; objects join with '.', array items get `[index]` suffixes. */
function collectLeaves(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLeaves(item, `${path}[${index}]`, out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectLeaves(child, path === '' ? key : `${path}.${key}`, out)
    }
    return
  }
  out.set(path, value)
}

/** Line for a leaf path: the literal key first, then the closest matching parent segment (nested tables hold no dotted literals). */
function locateKeyLine(source, path) {
  const segments = path.split(/\.|\[\d+\]/).filter(Boolean)
  for (let end = segments.length; end >= 1; end--) {
    const offset = source.indexOf(JSON.stringify(segments.slice(0, end).join('.')))
    if (offset !== -1) return source.slice(0, offset).split('\n').length
  }
  return 1
}

/** Sorted, de-duplicated placeholder tokens of a string value; null for non-string leaves. */
function placeholders(value) {
  if (typeof value !== 'string') return null
  return [...new Set(value.match(PLACEHOLDER) ?? [])].sort()
}

const localeFindings = []
const localeTables = new Map()

for (const name of LOCALE_NAMES) {
  const file = join(CLIENT_ROOT, LOCALE_DIR, name)
  const source = readFileSync(file, 'utf8')
  const leaves = new Map()
  collectLeaves(JSON.parse(source), '', leaves)
  localeTables.set(name, { relPath: `${LOCALE_DIR}/${name}`, source, leaves })

  for (const [key, value] of leaves) {
    if (!CJK.test(String(value))) continue
    localeFindings.push({
      file: `${LOCALE_DIR}/${name}`,
      line: locateKeyLine(source, key),
      text: `${key}: ${String(value)}`,
    })
  }
}

// The active locales must stay aligned: identical leaf keys and identical
// placeholder sets. A renamed or dropped {placeholder} silently breaks the UI,
// and a key present on one side only means a missing or orphaned string.
const enTable = localeTables.get('en.json')
const ukTable = localeTables.get('uk.json')
if (enTable && ukTable) {
  for (const key of enTable.leaves.keys()) {
    if (!ukTable.leaves.has(key)) {
      localeFindings.push({
        file: enTable.relPath,
        line: locateKeyLine(enTable.source, key),
        text: `missing in uk.json: ${key}`,
      })
    }
  }
  for (const key of ukTable.leaves.keys()) {
    if (!enTable.leaves.has(key)) {
      localeFindings.push({
        file: ukTable.relPath,
        line: locateKeyLine(ukTable.source, key),
        text: `missing in en.json: ${key}`,
      })
    }
  }
  for (const [key, enValue] of enTable.leaves) {
    if (!ukTable.leaves.has(key)) continue
    const enPlaceholders = placeholders(enValue)
    const ukPlaceholders = placeholders(ukTable.leaves.get(key))
    if (enPlaceholders === null || ukPlaceholders === null) continue
    if (enPlaceholders.join(' ') === ukPlaceholders.join(' ')) continue
    localeFindings.push({
      file: ukTable.relPath,
      line: locateKeyLine(ukTable.source, key),
      text: `placeholder mismatch: ${key} (en: ${enPlaceholders.join(', ') || 'none'} | uk: ${ukPlaceholders.join(', ') || 'none'})`,
    })
  }
}

const findings = []
for (const file of walk(SRC_ROOT)) {
  const relPath = relative(CLIENT_ROOT, file)
  if (isAllowed(relPath)) continue
  const source = readFileSync(file, 'utf8')
  for (const item of findChinese(file, source)) {
    findings.push({ file: relPath.split(sep).join('/'), ...item })
  }
}
findings.push(...localeFindings)

if (findings.length === 0) {
  console.log('check-i18n: no hardcoded Chinese outside the allowlist; en/uk locales are consistent.')
  process.exit(0)
}

const byFile = new Map()
for (const item of findings) {
  byFile.set(item.file, (byFile.get(item.file) ?? 0) + 1)
}

if (showAll) {
  for (const item of findings) {
    console.log(`${item.file}:${item.line}: ${item.text}`)
  }
} else {
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
    console.log(`${String(count).padStart(4)}  ${file}`)
  }
}

console.log(`\ncheck-i18n: ${findings.length} finding(s) in ${byFile.size} file(s).`)
if (strict) {
  console.error('check-i18n: --strict is on, failing.')
  process.exit(1)
}
process.exit(0)

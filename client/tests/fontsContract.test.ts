import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Pins the self-hosted Nunito setup.
 *
 * The main window used to load Nunito from Google Fonts, which leaked a startup
 * request to Google and fell back to a system font while offline. The contract is
 * now: index.html references no external font origins, index.css declares local
 * Nunito faces for the weights the UI uses (700/800) with latin and cyrillic
 * ranges, the bundled files exist, and the OFL license ships next to them.
 */
const CLIENT_ROOT = fileURLToPath(new URL('..', import.meta.url))
const INDEX_HTML_PATH = resolve(CLIENT_ROOT, 'index.html')
const INDEX_CSS_PATH = resolve(CLIENT_ROOT, 'src/index.css')

function readNunitoFaces(): string[] {
  const css = readFileSync(INDEX_CSS_PATH, 'utf8')
  return [...css.matchAll(/@font-face\s*{([^}]*)}/g)]
    .map((match) => match[1])
    .filter((block) => /font-family:\s*['"]Nunito['"]/.test(block))
}

describe('self-hosted Nunito', () => {
  it('does not reference external font origins from the main HTML entry', () => {
    const html = readFileSync(INDEX_HTML_PATH, 'utf8')

    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/)
  })

  it('declares local latin and cyrillic faces covering weights 700 and 800', () => {
    const faces = readNunitoFaces()

    expect(faces.length).toBeGreaterThanOrEqual(2)

    for (const face of faces) {
      expect(face).toMatch(/font-weight:\s*700\s+800\s*;/)
      expect(face).toMatch(/font-display:\s*swap\s*;/)
      expect(face).toMatch(/unicode-range:/)
    }

    const ranges = faces.map((face) => face.match(/unicode-range:\s*([^;]+);/)?.[1] ?? '')
    expect(ranges.some((range) => range.includes('U+0000-00FF'))).toBe(true)
    expect(ranges.some((range) => range.includes('U+0400-045F'))).toBe(true)
  })

  it('serves every declared font file from bundled assets', () => {
    const urls = readNunitoFaces().flatMap((face) =>
      [...face.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((match) => match[1]),
    )

    expect(urls.length).toBeGreaterThanOrEqual(2)

    for (const url of urls) {
      expect(url).not.toMatch(/^https?:/)
      const fontPath = resolve(dirname(INDEX_CSS_PATH), url)
      expect(existsSync(fontPath), fontPath).toBe(true)
      expect(statSync(fontPath).size).toBeGreaterThan(0)
    }
  })

  it('ships the SIL OFL license next to the font files', () => {
    const license = readFileSync(resolve(dirname(INDEX_CSS_PATH), 'assets/fonts/OFL.txt'), 'utf8')

    expect(license).toContain('SIL OPEN FONT LICENSE Version 1.1')
    expect(license).toContain('The Nunito Project Authors')
  })
})

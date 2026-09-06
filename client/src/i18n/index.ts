/**
 * 极简 i18n 运行时。
 *
 * 为什么不引 i18next：这里需要的只有「查表 + 插值」，而项目的既有做法是
 * 「纯逻辑抽成文件 + vitest 锁不变量」。自建的最大好处是 **key 类型安全**——
 * 漏 key、拼错 key 在 tsc 阶段就报错，而不是运行时静默 fallback 成 key 本身。
 * locale 文件保持平铺 JSON，将来要迁 i18next 或接 Crowdin 都没有摩擦。
 *
 * ⚠️ The locale here governs UI text only; the recognition language is a separate concern:
 * `speechInput.language` is the language sent to ASR (and to cleanup prompts), the Preset
 * decides the output language. None of them are affected by this module. When touching
 * this file, do not casually couple them together.
 */
import en from './locales/en.json'
import uk from './locales/uk.json'

export const LOCALES = ['en', 'uk'] as const
export type Locale = (typeof LOCALES)[number]

/** 语言偏好：'auto' = 跟随系统，解析后一定落在某个具体 Locale 上。 */
export type LanguagePreference = 'auto' | Locale

/** Translation keys come from the English table, which is the source locale. */
export type TranslationKey = keyof typeof en

/**
 * The Ukrainian table is explicitly checked against the source keys at compile time;
 * extra keys are covered by `__tests__/locales.test.ts`.
 */
const TABLES: Record<Locale, Record<TranslationKey, string>> = {
  en,
  uk,
}

const DEFAULT_LOCALE: Locale = 'en'

let currentLocale: Locale = DEFAULT_LOCALE
const listeners = new Set<() => void>()

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * 把系统/浏览器给的 locale 串解析成受支持的界面语言。
 *
 * Chinese system locales fall back to English because Chinese is not a supported
 * interface locale. Ukrainian accepts the language code itself and common regional
 * variants. Everything else falls back to English.
 */
export function resolveLocale(raw: string | null | undefined): Locale {
  const tag = (raw || '').trim().toLowerCase()
  if (!tag) return 'en'
  if (tag.startsWith('zh')) return 'en'
  if (tag === 'uk' || tag === 'uk-ua' || tag === 'uk_ua') return 'uk'
  return 'en'
}

/** 归一化持久化的偏好值；脏数据一律回落 'auto'。 */
export function normalizePreference(value: unknown): LanguagePreference {
  if (value === 'auto') return 'auto'
  if (typeof value === 'string' && value.trim().toLowerCase().startsWith('zh')) return 'en'
  return isLocale(value) ? value : 'auto'
}

export function getLocale(): Locale {
  return currentLocale
}

/**
 * 切换当前界面语言。
 *
 * 同步生效、同步通知，`useT()` 依赖这一点：切语言后当帧就能重渲染，不需要重启。
 * 只写内存，不落库 —— 持久化是 `stores/language.ts` 的职责。
 */
export function setLocale(locale: Locale): void {
  if (!isLocale(locale)) return
  // Synchronize <html lang> even when the locale has not changed; the initial
  // default locale still needs an explicit document update.
  applyDocumentLocale(locale)
  if (locale === currentLocale) return
  currentLocale = locale
  listeners.forEach((listener) => listener())
}

/**
 * Keep the document language synchronized for accessibility and browser formatting.
 */
function applyDocumentLocale(locale: Locale): void {
  if (typeof document === 'undefined') return
  document.documentElement.lang = locale
}

/** 供 useSyncExternalStore 使用。 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 取一条文案。`params` 里的键按 `{name}` 占位替换。
 *
 * 缺 key 时依次回落：当前语言 → 英文表 → key 本身。回落到 key 本身意味着
 * 界面上会出现 `nav.home` 这种东西，刺眼是故意的 —— 它比显示空字符串好排查。
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const table = TABLES[currentLocale]
  const template = table[key] ?? TABLES[DEFAULT_LOCALE][key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

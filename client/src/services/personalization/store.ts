import { getSetting, getUsageSummary, setSetting } from '@/services/store'
import { BUILTIN_APP_RULES } from './defaults'
import type { UsageSummary } from '@/types/usage'
import type {
  AppPromptMatcher,
  AppPromptRule,
  UserStats,
} from './types'

const APP_PROMPT_RULES_KEY = 'appPromptRules'

function normalizeMatcher(value: unknown): AppPromptMatcher {
  const matcher = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const normalizeList = (input: unknown) => Array.isArray(input)
    ? input.map((item) => String(item || '').trim()).filter(Boolean)
    : []

  return {
    processNames: normalizeList(matcher.processNames),
    windowTitleIncludes: normalizeList(matcher.windowTitleIncludes),
    windowClasses: normalizeList(matcher.windowClasses),
    automationIds: normalizeList(matcher.automationIds),
  }
}

function normalizeAppPromptRule(raw: unknown, fallback?: AppPromptRule): AppPromptRule | null {
  if (!raw || typeof raw !== 'object') return fallback ? { ...fallback } : null
  const value = raw as Record<string, unknown>
  const id = String(value.id || fallback?.id || '').trim()
  const appId = String(value.appId || fallback?.appId || '').trim()
  const name = String(value.name || fallback?.name || '').trim()
  if (!id || !appId || !name) return fallback ? { ...fallback } : null

  return {
    id,
    appId,
    name,
    builtin: value.builtin === true || fallback?.builtin === true,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : fallback?.enabled ?? false,
    presetId: String(value.presetId ?? fallback?.presetId ?? '').trim() || undefined,
    promptAppend: String(value.promptAppend ?? fallback?.promptAppend ?? '').trim(),
    matcher: normalizeMatcher(value.matcher ?? fallback?.matcher ?? {}),
  }
}

/**
 * 读取应用规则，**原样保留存档里的数组顺序**（顺序即优先级，见 AppPromptRule 的注释）。
 *
 * 这里不能再按任何字段重排：界面上拖出来的顺序就是存进去的顺序，重排一次就等于
 * 用户白拖。老存档虽然带着 priority，但当时写入前已经按它排好序了，直接沿用即可。
 */
export async function getAppPromptRules(): Promise<AppPromptRule[]> {
  const saved = await getSetting<unknown>(APP_PROMPT_RULES_KEY, [])
  const builtinById = new Map(BUILTIN_APP_RULES.map((rule) => [rule.id, rule]))
  const ordered: AppPromptRule[] = []
  const seen = new Set<string>()

  if (Array.isArray(saved)) {
    for (const item of saved) {
      const id = String((item as { id?: unknown } | null)?.id ?? '').trim()
      // 内置规则以 BUILTIN_APP_RULES 为骨架（用户只能改其中几个字段，删不掉）；
      // 不在内置清单里的是用户自建规则，原样保留。
      const skeleton = builtinById.get(id)
      const normalized = normalizeAppPromptRule(item, skeleton)
      if (!normalized || seen.has(normalized.id)) continue
      seen.add(normalized.id)
      ordered.push(skeleton ? normalized : { ...normalized, builtin: false })
    }
  }

  // 存档里没出现过的内置规则：全新安装（此时顺序就是 BUILTIN_APP_RULES 的顺序），
  // 或版本更新新增的规则 —— 后者追加到末尾。新增的内置规则默认关闭，位置不影响行为，
  // 用户启用它时会自动置顶。
  const missing = BUILTIN_APP_RULES
    .filter((rule) => !seen.has(rule.id))
    .map((rule) => ({ ...rule, matcher: { ...rule.matcher } }))

  return [...ordered, ...missing]
}

export async function saveAppPromptRules(rules: AppPromptRule[]): Promise<void> {
  await setSetting(APP_PROMPT_RULES_KEY, rules)
}

/**
 * Personalization stats are a view of the all-time usage log, not a stored
 * counter. `totalWords` sums attributed characters only, as the old counter
 * did (it always equalled the sum of `domainWords`): the undated legacy
 * remainder has no app and would otherwise dilute the scene ratios that gate
 * the identity prompt.
 */
export function userStatsFromUsageSummary(summary: UsageSummary): UserStats {
  const domainWords: Record<string, number> = {}
  const appUsageCount: Record<string, number> = {}
  let attributedChars = 0
  for (const app of summary.apps) {
    if (app.chars > 0) domainWords[app.key] = app.chars
    if (app.takes > 0) appUsageCount[app.key] = app.takes
    attributedChars += Math.max(0, app.chars)
  }
  return {
    totalWords: attributedChars,
    totalSessions: summary.takes,
    domainWords,
    appUsageCount,
    firstUsedAt: summary.firstUsedAt ?? undefined,
    lastUsedAt: summary.lastUsedAt ?? undefined,
  }
}

export async function getUserStats(): Promise<UserStats> {
  return userStatsFromUsageSummary(await getUsageSummary(null))
}

import type { ActiveAppContext } from '@/types/appContext'
import { BUILTIN_PRESETS } from '@/services/store'
import type { AppPromptRule, PromptResolution, PromptRoutingInput } from './types'
import { buildDynamicIdentityPrompt, summarizeDomainScenes } from './userStats'

function normalizeText(value?: string) {
  return String(value || '').trim().toLowerCase()
}

function normalizeProcessName(context: ActiveAppContext | null) {
  const processName = normalizeText(context?.processName)
  if (processName) return processName

  const exePath = String(context?.exePath || '')
  const segments = exePath.split(/[\\/]/)
  return normalizeText(segments[segments.length - 1])
}

function includesAny(value: string, patterns?: string[]) {
  if (!value || !patterns?.length) return false
  return patterns.some((pattern) => value.includes(normalizeText(pattern)))
}

/**
 * 判断一条应用规则是否命中当前窗口。
 *
 * 进程名是硬证据，窗口标题只是软线索 —— 所以**只要规则写了进程名、且这次确实拿到了
 * 进程名，就只按进程名判定**，标题不再独立触发。
 *
 * 原来两者是「或」的关系，而标题是「包含即命中」，一个标题能同时命中多条规则：
 * 在 Outlook 里写一封标题为「Teams 会议纪要 - Outlook」的邮件时，Teams 规则也会命中，
 * 又因为 Teams 优先级更高，最终按"即时聊天短消息"来整理这封正式邮件。
 *
 * 保留标题/类名/控件 ID 的能力，是给"进程名区分不了"的场景兜底：
 *   · 规则本身没写进程名（如网页版应用，进程都是浏览器，只能靠标题区分）；
 *   · 少数窗口拿不到进程名（此时不能因为进程名为空就直接判不命中）。
 */
export function matchesAppPromptRule(rule: AppPromptRule, context: ActiveAppContext | null) {
  if (!context) return false

  const processName = normalizeProcessName(context)

  if (rule.matcher.processNames.length > 0 && processName) {
    return rule.matcher.processNames.some((candidate) => processName === normalizeText(candidate))
  }

  const windowTitle = normalizeText(context.windowTitle)
  const windowClass = normalizeText(context.windowClass)
  const automationId = normalizeText(context.automationId)
  if (includesAny(windowTitle, rule.matcher.windowTitleIncludes)) return true
  if (includesAny(windowClass, rule.matcher.windowClasses)) return true
  if (includesAny(automationId, rule.matcher.automationIds)) return true
  return false
}

function pickPreset(presetId: string | undefined, presets: PromptRoutingInput['presets'], activePresetId: string) {
  const fallback = presets.find((preset) => preset.id === activePresetId)
    || BUILTIN_PRESETS.find((preset) => preset.id === activePresetId)
    || presets[0]
    || BUILTIN_PRESETS[0]

  if (!presetId) return fallback
  return presets.find((preset) => preset.id === presetId)
    || BUILTIN_PRESETS.find((preset) => preset.id === presetId)
    || fallback
}

function summarizeResolution(parts: string[]) {
  return parts.filter(Boolean).join(' | ')
}

/** 构造"热词注入 AI 提示词"的段落；无热词时返回 null。供实时与重新识别两条路径共用。 */
export function buildHotwordInjectionPart(hotwords: string[] | undefined): string | null {
  if (!hotwords || hotwords.length === 0) return null
  const terms = Array.from(new Set(hotwords.map((w) => w.trim()).filter(Boolean)))
  if (terms.length === 0) return null
  return `User Glossary: The following are proper nouns and terms frequently used by the user. If you encounter phonetically similar or misrecognized words during cleanup, prioritize correcting them to the following spellings (preserving exact casing) and keep them intact:\n${terms.join(', ')}`
}

export function resolvePromptRouting(input: PromptRoutingInput): PromptResolution {
  // 顺序即优先级：取列表里第一条「已启用且命中」的规则，也就是界面上自上而下的第一条。
  // 顺序完全由用户在界面上排（启用一条会自动置顶），这里不要再重排。
  const matchedRule = input.appRules
    .find((rule) => rule.enabled && matchesAppPromptRule(rule, input.appContext))

  const preset = pickPreset(matchedRule?.presetId, input.presets, input.activePresetId)
  const systemPromptParts = [preset.systemPrompt.trim()]
  const dominantScene = summarizeDomainScenes(input.userStats, 1)[0]

  if (matchedRule?.promptAppend) {
    systemPromptParts.push(`Application context:\n${matchedRule.promptAppend.trim()}`)
  }

  const dynamicIdentityPrompt = buildDynamicIdentityPrompt(input.userStats)
  if (dynamicIdentityPrompt) {
    systemPromptParts.push(`User profile context:\n${dynamicIdentityPrompt}`)
  }

  // 可选：把热词表注入系统提示词，帮助 AI 在整理时纠正/保留专有名词（默认关闭）。
  let hotwordInjected = false
  if (input.injectHotwords) {
    const part = buildHotwordInjectionPart(input.hotwords)
    if (part) {
      systemPromptParts.push(part)
      hotwordInjected = true
    }
  }

  const summaryParts = [
    `Base preset id: ${preset.id}`,
    matchedRule ? `App rule id: ${matchedRule.id}` : 'App rule: no match',
    dynamicIdentityPrompt && dominantScene ? `User profile: ${dominantScene.label}` : '',
    hotwordInjected ? 'Hotwords injected: yes' : '',
  ]

  return {
    appId: matchedRule?.appId,
    appName: matchedRule?.name,
    preset,
    matchedRule,
    systemPrompt: systemPromptParts.join('\n\n'),
    summary: summarizeResolution(summaryParts),
  }
}

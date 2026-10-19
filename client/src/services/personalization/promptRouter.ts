import type { ActiveAppContext } from '@/types/appContext'
import { BUILTIN_PRESETS } from '@/services/store'
import type { AppPromptRule, PromptResolution, PromptRoutingInput } from './types'
import { buildDynamicIdentityPrompt, summarizeDomainScenes } from './userStats'
import { applySpeechLanguageToPrompt } from '@/services/speechInputLanguage'

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
 * Determines whether an app rule matches the current window.
 *
 * The process name is hard evidence; the window title is only a soft hint. So **as soon as
 * the rule specifies process names and we actually obtained one this time, matching is decided
 * by the process name alone**; the title no longer triggers a match on its own.
 *
 * Previously the two were combined with OR, and a title match was "contains → hit", so a single
 * title could hit several rules at once: when writing an email titled "Teams meeting notes - Outlook"
 * in Outlook, the Teams rule also matched, and because Teams had higher priority, this formal email
 * was ultimately cleaned up as an "instant chat short message".
 *
 * Keeping title/class name/control ID matching is a fallback for cases the process name cannot tell apart:
 *   · the rule itself does not specify process names (e.g. web apps, where every process is the browser
 *     and only the title can distinguish them);
 *   · a few windows do not expose a process name (in that case an empty process name must not by
 *     itself mean "no match").
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

/** Builds the "hotword injection into the AI prompt" section; returns null when there are no hotwords. Shared by the live and re-recognition paths. */
export function buildHotwordInjectionPart(hotwords: string[] | undefined): string | null {
  if (!hotwords || hotwords.length === 0) return null
  const terms = Array.from(new Set(hotwords.map((w) => w.trim()).filter(Boolean)))
  if (terms.length === 0) return null
  return `User Hotwords: The following are proper nouns and terms frequently used by the user. If you encounter phonetically similar or misrecognized words during cleanup, prioritize correcting them to the following spellings (preserving exact casing) and keep them intact:\n${terms.join(', ')}`
}

export function resolvePromptRouting(input: PromptRoutingInput): PromptResolution {
  // Order is priority: take the first enabled rule that matches, i.e. the top-most one in the UI.
  // The user fully controls the order in the UI (enabling a rule moves it to the top), so do not re-sort here.
  const matchedRule = input.appRules
    .find((rule) => rule.enabled && matchesAppPromptRule(rule, input.appContext))

  const preset = pickPreset(matchedRule?.presetId, input.presets, input.activePresetId)
  const systemPromptParts = [preset.systemPrompt.trim()]
  const speechLanguagePart = input.speechLanguage
    ? applySpeechLanguageToPrompt(preset, input.speechLanguage)
    : null
  if (speechLanguagePart) systemPromptParts.push(speechLanguagePart)
  const dominantScene = summarizeDomainScenes(input.userStats, 1)[0]

  if (matchedRule?.promptAppend) {
    systemPromptParts.push(`Application context:\n${matchedRule.promptAppend.trim()}`)
  }

  const dynamicIdentityPrompt = buildDynamicIdentityPrompt(input.userStats)
  if (dynamicIdentityPrompt) {
    systemPromptParts.push(`User profile context:\n${dynamicIdentityPrompt}`)
  }

  // Optional: inject the hotword list into the system prompt so the AI corrects/keeps proper nouns during cleanup (off by default).
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
    speechLanguagePart ? `Speech language: ${input.speechLanguage}` : '',
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

import { describe, it, expect } from 'vitest'
import { matchesAppPromptRule, resolvePromptRouting } from '../promptRouter'
import { BUILTIN_APP_RULES } from '../defaults'
import type { AppPromptRule } from '../types'
import type { ActiveAppContext } from '@/types/appContext'
import { withContextAwareInstructions } from '../../contextAware'

function ruleById(id: string): AppPromptRule {
  const rule = BUILTIN_APP_RULES.find((r) => r.id === id)
  if (!rule) throw new Error(`内置规则不存在: ${id}`)
  return rule
}

describe('matchesAppPromptRule', () => {
  it('进程名匹配时命中', () => {
    const ctx: ActiveAppContext = { processName: 'outlook.exe', windowTitle: '收件箱 - Outlook' }
    expect(matchesAppPromptRule(ruleById('outlook'), ctx)).toBe(true)
  })

  it('拿到进程名时，标题不再独立触发：在 Outlook 里写含 Teams 的邮件不应命中 Teams', () => {
    // 这是改动前的真实误判：标题「包含」teams 就命中 Teams 规则，
    // 且 Teams 优先级(100) > Outlook(95)，正式邮件会被按即时聊天风格整理。
    const ctx: ActiveAppContext = { processName: 'outlook.exe', windowTitle: 'Teams 会议纪要 - Outlook' }
    expect(matchesAppPromptRule(ruleById('teams'), ctx)).toBe(false)
    expect(matchesAppPromptRule(ruleById('outlook'), ctx)).toBe(true)
  })

  it('短关键词不再误伤：在 VSCode 里编辑 qq_faq.md 不应命中 QQ', () => {
    const ctx: ActiveAppContext = { processName: 'code.exe', windowTitle: 'qq_faq.md - proj - Visual Studio Code' }
    expect(matchesAppPromptRule(ruleById('qq'), ctx)).toBe(false)
    expect(matchesAppPromptRule(ruleById('vscode'), ctx)).toBe(true)
  })

  it('进程名对不上就是不命中（不再靠标题捞回来）', () => {
    const ctx: ActiveAppContext = { processName: 'chrome.exe', windowTitle: 'Outlook - Google Chrome' }
    expect(matchesAppPromptRule(ruleById('outlook'), ctx)).toBe(false)
  })

  it('规则没写进程名时（如网页版应用）回落到标题匹配', () => {
    const webRule: AppPromptRule = {
      ...ruleById('outlook'),
      id: 'outlook-web',
      matcher: { processNames: [], windowTitleIncludes: ['outlook'] },
    }
    const ctx: ActiveAppContext = { processName: 'msedge.exe', windowTitle: '收件箱 - Outlook - Microsoft Edge' }
    expect(matchesAppPromptRule(webRule, ctx)).toBe(true)
  })

  it('拿不到进程名时仍回落到标题匹配（不能因为进程名为空就判不命中）', () => {
    // 内置规则已不带标题列表，这里显式构造一条"两者都写"的规则来验证兜底分支
    const rule: AppPromptRule = {
      ...ruleById('outlook'),
      matcher: { processNames: ['outlook.exe'], windowTitleIncludes: ['outlook'] },
    }
    const ctx: ActiveAppContext = { windowTitle: '收件箱 - Outlook' }
    expect(matchesAppPromptRule(rule, ctx)).toBe(true)
  })

  it('内置规则不再带窗口标题列表（避免标题匹配把别的应用抢走）', () => {
    for (const rule of BUILTIN_APP_RULES) {
      expect(rule.matcher.processNames.length).toBeGreaterThan(0)
      expect(rule.matcher.windowTitleIncludes ?? []).toHaveLength(0)
    }
  })

  it('进程名从 exePath 兜底解析', () => {
    const ctx: ActiveAppContext = { exePath: 'C:\\Program Files\\Notepad\\notepad.exe' }
    expect(matchesAppPromptRule(ruleById('notepad'), ctx)).toBe(true)
  })

  it('无上下文时不命中', () => {
    expect(matchesAppPromptRule(ruleById('teams'), null)).toBe(false)
  })
})

describe('speech language prompt augmentation', () => {
  const base = {
    appContext: null,
    presets: [{ id: 'intent', name: 'Intent', builtin: true, systemPrompt: 'Base' }],
    activePresetId: 'intent', appRules: [],
    userStats: { totalWords: 0, totalSessions: 0, domainWords: {}, appUsageCount: {} },
  }
  it('adds language guidance for cleanup built-ins', () => {
    for (const id of ['intent', 'faithful', 'casual']) {
      const result = resolvePromptRouting({ ...base, presets: [{ id, name: id, builtin: true, systemPrompt: 'Base' }], activePresetId: id, speechLanguage: 'ru' })
      expect(result.systemPrompt).toContain('Russian')
      expect(result.systemPrompt).toContain('same language')
      expect(result.summary).toContain('Speech language: ru')
    }
  })
  it('does not add guidance for auto, translation, or user presets', () => {
    for (const preset of [{ id: 'intent', builtin: true }, { id: 'translate_uk', builtin: true }, { id: 'translate_ru', builtin: true }, { id: 'translate_en', builtin: true }, { id: 'custom', builtin: false }]) {
      const result = resolvePromptRouting({ ...base, presets: [{ ...preset, name: preset.id, systemPrompt: 'Base' }], activePresetId: preset.id, speechLanguage: preset.id === 'intent' ? 'auto' : 'ru' })
      expect(result.systemPrompt).not.toContain('Speech language:')
      expect(result.summary).not.toContain('Speech language:')
    }
  })
  it('drops guidance for selected text but keeps it for caret context', () => {
    const routed = resolvePromptRouting({ ...base, speechLanguage: 'ru' })
    const selected = withContextAwareInstructions(routed.systemPrompt, { source: 'test', textBefore: '', selectedText: 'text', textAfter: '', selectionTruncated: false })
    const caret = withContextAwareInstructions(routed.systemPrompt, { source: 'test', textBefore: 'before', selectedText: '', textAfter: '', selectionTruncated: false })
    expect(selected).not.toContain('Speech language:')
    expect(caret).toContain('in Russian')
  })
})

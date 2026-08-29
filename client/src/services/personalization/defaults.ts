import type { AppPromptRule, UserStats } from './types'

// 这里的**数组顺序就是默认优先级**（自上而下先命中先生效，见 promptRouter）。
// 用户可以在界面上拖动调整，调整后的顺序存进 appPromptRules；这份清单只决定
// 「从没动过」时的初始顺序，以及后续版本新增的内置规则追加在哪。
//
// 内置规则一律只靠 processNames 判定（见 promptRouter.matchesAppPromptRule）。
// 这里**不要**再加 windowTitleIncludes：标题是「包含即命中」，一个标题能同时命中
// 多条规则 —— 曾导致在 Outlook 里写标题含「Teams」的邮件被 Teams 规则抢走。
// 标题匹配只保留给「进程名区分不了」的场景（如网页版应用，进程都是浏览器）。

export const BUILTIN_APP_RULES: AppPromptRule[] = [
  {
    id: 'teams',
    appId: 'teams',
    name: 'Teams',
    builtin: true,
    enabled: false,
    presetId: 'intent',
    promptAppend: 'Suitable for instant messaging chat. Output short messages ready to send, with a natural, clear, and concise tone, avoiding an email-like style.',
    matcher: {
      processNames: ['teams.exe', 'ms-teams.exe'],
    },
  },
  {
    id: 'outlook',
    appId: 'outlook',
    name: 'Outlook',
    builtin: true,
    enabled: false,
    presetId: 'intent',
    promptAppend: 'Suitable for work email drafts. Formal, complete tone with natural paragraph breaks when appropriate, without fabricating recipients, greetings, or facts.',
    matcher: {
      processNames: ['outlook.exe', 'olk.exe'],
    },
  },
  {
    id: 'kiro',
    appId: 'kiro',
    name: 'Kiro',
    builtin: true,
    enabled: false,
    presetId: 'faithful',
    promptAppend: 'For developer tool input. Preserve code, commands, filenames, paths, English identifiers, and Markdown structures. Do not rewrite technical terms into plain words.',
    matcher: {
      processNames: ['kiro.exe'],
    },
  },
  {
    id: 'codex',
    appId: 'codex',
    name: 'Codex',
    builtin: true,
    enabled: false,
    presetId: 'faithful',
    promptAppend: 'For Codex coding tools, mostly programming instructions in natural language. Preserve code, commands, filenames, paths, and English identifiers; state the task clearly without rewriting technical terms.',
    matcher: {
      processNames: ['codex.exe'],
    },
  },
  {
    id: 'vscode',
    appId: 'vscode',
    name: 'VSCode',
    builtin: true,
    enabled: false,
    presetId: 'faithful',
    promptAppend: 'For VSCode editor. Preserve code, commands, filenames, APIs, English terminology, and Markdown structures without over-polishing technical content.',
    matcher: {
      processNames: ['code.exe'],
    },
  },
  {
    id: 'cursor',
    appId: 'cursor',
    name: 'Cursor',
    builtin: true,
    enabled: false,
    presetId: 'faithful',
    promptAppend: 'For Cursor editor. Preserve code, commands, paths, technical terms, and English identifiers without explaining or auto-completing technical content.',
    matcher: {
      processNames: ['cursor.exe'],
    },
  },
  {
    id: 'notepad',
    appId: 'notepad',
    name: 'Notepad',
    builtin: true,
    enabled: false,
    presetId: 'intent',
    promptAppend: 'For Windows Notepad, suitable for plain text quick notes. Output plain text without Markdown formatting or special symbols.',
    matcher: {
      processNames: ['notepad.exe'],
    },
  },
  {
    id: 'weixin',
    appId: 'weixin',
    name: 'WeChat',
    builtin: true,
    enabled: false,
    presetId: 'casual',
    promptAppend: 'Suitable for instant messaging chat. Output natural, casual short messages ready to send, concise and friendly without formal tone.',
    matcher: {
      processNames: ['weixin.exe', 'wechat.exe'],
    },
  },
  {
    id: 'qq',
    appId: 'qq',
    name: 'QQ',
    builtin: true,
    enabled: false,
    presetId: 'casual',
    promptAppend: 'Suitable for instant messaging chat. Output casual, natural short messages ready to send, informal and concise.',
    matcher: {
      processNames: ['qq.exe'],
    },
  },
]

export function createDefaultUserStats(): UserStats {
  return {
    totalWords: 0,
    totalSessions: 0,
    domainWords: {},
    appUsageCount: {},
  }
}

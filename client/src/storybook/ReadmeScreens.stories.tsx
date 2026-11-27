import type { ReactNode } from 'react'
import type { Meta, StoryObj } from '@storybook/react-vite'
import TitleBar from '@/components/TitleBar'
import Sidebar from '@/components/Sidebar'
import Home from '@/pages/Home'
import History from '@/pages/History'
import VoiceEnginePage from '@/features/settings/VoiceEnginePage'
import AIServicePage from '@/features/settings/AIServicePage'
import AIInstructionsPage from '@/features/settings/AIInstructionsPage'
import AppearancePage from '@/features/settings/AppearancePage'
import type { AiProfile } from '@/features/settings/aiProviderCatalog'
import type { AsrProfile } from '@/features/settings/asrProviderCatalog'
import { getLocale } from '@/i18n'
import { setMotionEnabled } from '@/lib/motion'
import type { HistoryRecord } from '@/services/store'
import { initProviderFromStore } from '@/services/transcription'
import { setAiEnabled } from '@/stores/aiEnabled'
import { getTauriJournal } from '@/storybook/tauriMock'
import type { UsageSummary } from '@/types/usage'

// Source of the README screenshots (docs/images/readme/*-en.png and *-ua.png). Each story renders
// the whole main window as App.tsx lays it out, so a capture at the window's default 1120x768 size
// matches the real app. Regenerate them with `npm run screenshots:readme` from client/
// (scripts/capture-readme-screenshots.mjs); a new screen needs a story here and an entry in that
// script's SHOTS list.
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto bg-background p-8">
          <div className="page-enter">{children}</div>
        </main>
      </div>
    </div>
  )
}

const now = Date.now()
const minute = 60_000
const hour = 60 * minute
const day = 24 * hour

const usageSummary: UsageSummary = {
  takes: 412,
  totalChars: 33_290,
  totalDurationSec: 2_614,
  datedTakes: 412,
  datedChars: 33_290,
  maxDurationSec: 95,
  activeDays: 23,
  hourBuckets: Array.from({ length: 24 }, (_, h) => (h >= 9 && h <= 18 ? 30 : 2)),
  apps: [{ key: 'code.exe', takes: 160, chars: 14_100 }],
  workModes: [{ key: 'cloud_api', takes: 412, chars: 33_290 }],
  promptPresets: [{ key: 'intent', takes: 300, chars: 25_000 }],
  firstUsedAt: now - 40 * day,
  lastUsedAt: now - 15 * minute,
}

function atLocalDay(daysAgo: number, h: number, m: number): number {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  date.setHours(h, m, 0, 0)
  return date.getTime()
}

const historyText = {
  en: [
    'Remind me that tomorrow at 10:00 we have a sync with the design team, and I need to prepare a short release update.',
    'Thanks for the feedback! I will send the updated pricing page by the end of the day.',
    'The investor meeting moved to Thursday at 2:30 PM. We will meet in the conference room on the third floor.',
    'Please review the PR that fixes file exports — there was an issue with dots in the source name.',
    'Buy coffee, pick up the package, and call the doctor.',
    'Draft the release notes: the new transcription and subtitles pages, export fixes, and the updated hotword dictionary.',
  ],
  uk: [
    'Нагадай, будь ласка, що завтра о 10:00 у нас синк із командою дизайну, і мені треба підготувати короткий апдейт по релізу.',
    'Дякую за фідбек! Оновлену версію сторінки з цінами я надішлю до кінця дня.',
    'Зустріч з інвесторами переноситься на четвер, 14:30. Зустрічаємось у переговорній на третьому поверсі.',
    'Розглянь, будь ласка, PR із фіксом експорту файлів — там була проблема з крапкою в назві.',
    'Купити каву, забрати посилку з Нової пошти і зателефонувати лікарю.',
    'Підготувати короткий опис змін для релізу: нові сторінки транскрипції та субтитрів, виправлення експорту, оновлений словник термінів.',
  ],
} as const

function textRecord(id: string, timestamp: number, text: string, extra: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    id,
    timestamp,
    asrText: text,
    llmText: text,
    asrMs: 620,
    llmMs: 280,
    durationSec: 6.2,
    audioDurationSec: 6,
    charCount: text.length,
    workMode: 'cloud_api',
    asrProvider: 'deepgram',
    aiSource: 'custom',
    aiStatus: 'applied',
    aiProvider: 'groq',
    aiModel: 'openai/gpt-oss-120b',
    promptPresetId: 'intent',
    ...extra,
  }
}

function historyRecords(): HistoryRecord[] {
  const text = getLocale() === 'uk' ? historyText.uk : historyText.en
  return [
    textRecord('h1', atLocalDay(0, 16, 15), text[0], { favorite: true }),
    textRecord('h2', atLocalDay(0, 15, 36), text[1]),
    textRecord('h3', atLocalDay(0, 14, 4), text[2]),
    textRecord('h4', atLocalDay(1, 14, 24), text[3]),
    textRecord('h5', atLocalDay(1, 10, 24), text[4], { manualEditedAt: atLocalDay(1, 10, 30) }),
    {
      id: 'h6',
      timestamp: atLocalDay(1, 6, 24),
      asrText: '',
      llmText: '',
      asrMs: 0,
      llmMs: 0,
      durationSec: 2.1,
      charCount: 0,
      isEmpty: true,
      workMode: 'cloud_api',
      asrProvider: 'deepgram',
      aiSource: 'none',
      aiStatus: 'skipped',
    },
    textRecord('h7', atLocalDay(3, 16, 24), text[5]),
  ]
}

function asrProfile(id: string, provider: string, model: string, check?: AsrProfile['check']): AsrProfile {
  return {
    id,
    provider,
    model,
    apiKey: 'readme-placeholder-key',
    appId: '',
    console: 'new',
    otherKey: '',
    workspaceId: '',
    omniPrompt: '',
    deepgramKeytermsEnabled: false,
    check,
  }
}

const asrProfiles: AsrProfile[] = [
  asrProfile('asr-groq', 'groq_whisper', 'whisper-large-v3-turbo', { ok: true, at: now - 2 * hour, latencyMs: 633, audioSec: 3.2 }),
  asrProfile('asr-openai', 'openai_transcribe', 'gpt-transcribe', { ok: true, at: now - 3 * hour, latencyMs: 1_800, audioSec: 3.2 }),
  asrProfile('asr-deepgram', 'deepgram', 'nova-3', { ok: true, at: now - 20 * minute, latencyMs: 420, audioSec: 3.2 }),
]
const activeAsr = asrProfiles[2]

function aiProfile(id: string, provider: string, apiUrl: string, model: string, check?: AiProfile['check']): AiProfile {
  return { id, provider, apiUrl, apiKey: 'readme-placeholder-key', model, check }
}

const aiProfiles: AiProfile[] = [
  aiProfile('ai-zai', 'openai_compat', 'https://api.z.ai/api/paas/v4', 'glm-5.3', {
    ok: false,
    at: now - 5 * hour,
    reason: 'Invalid API key',
  }),
  aiProfile('ai-gemini', 'openai_compat', 'http://localhost:4000/v1', 'gemini-3.8-flash', { ok: true, at: now - 4 * hour, latencyMs: 8_100 }),
  aiProfile('ai-openai', 'openai', 'https://api.openai.com', 'gpt-6-luna', { ok: true, at: now - 3 * hour, latencyMs: 1_200 }),
  aiProfile('ai-groq', 'groq', 'https://api.groq.com/openai/v1', 'openai/gpt-oss-120b', { ok: true, at: now - 20 * minute, latencyMs: 280 }),
  aiProfile('ai-openrouter', 'openrouter', 'https://openrouter.ai/api/v1', 'openrouter/free', {
    ok: true,
    at: now - 2 * hour,
    latencyMs: 285,
  }),
  aiProfile('ai-opencode', 'opencode_go', 'https://opencode.ai/zen/go/v1', 'kimi-k2.6', { ok: true, at: now - hour, latencyMs: 940 }),
]

const sharedSettings = {
  theme: 'dark',
  'ui.animations': true,
  aiEnabled: true,
  workMode: 'cloud_api',
  dismissedNoticeIds: [],
  shortcutHandsFree: 'AltRight',
  shortcutPTT: 'ControlRight',
  shortcutToggleAi: 'Control+Shift+A',
  aiMinDurationSec: 2,
  injectHotwordsToPrompt: true,
  contextAwareWritingEnabled: true,
  'speechInput.language': 'auto',
  'cloudAsr.profiles': asrProfiles,
  'cloudAsr.activeProfileId': activeAsr.id,
  'cloudAsr.autoCreatedProviders': [],
  'cloudAsr.omniSystemPrompt': '',
  'cloudAsr.provider': activeAsr.provider,
  'cloudAsr.apiKey': activeAsr.apiKey,
  'cloudAsr.appId': '',
  'cloudAsr.qwen.workspaceId': '',
  'cloudAsr.doubao.console': 'new',
  'cloudAsr.doubao.consoleKey': '',
  'cloudAsr.doubao.apiKey': '',
  'cloudAsr.doubao.appId': '',
  'cloudAsr.qwen.apiKey': '',
  'cloudAsr.mimo.apiKey': '',
  'cloudAsr.groq.apiKey': '',
  'cloudAsr.openai.apiKey': '',
  'cloudAsr.gemini.apiKey': '',
  'cloudAsr.openrouter.apiKey': '',
  'cloudAsr.deepgram.apiKey': '',
  'cloudAsr.custom.apiKey': '',
  'cloudAi.profiles': aiProfiles,
  'cloudAi.activeProfileId': 'ai-groq',
  'cloudAi.profilesMigrated': true,
  'server.aiSource': 'managed',
  overlayShowDuration: true,
  streamingDisplayEnabled: true,
  overlayWaveTheme: 'black-white',
  overlayWidth: 'long',
}

const sharedCommands = {
  set_tray_ai_enabled: () => null,
  usage_summary: () => usageSummary,
  history_list: () => historyRecords(),
  history_count: () => historyRecords().length,
}

const meta = {
  title: 'readme/Screens',
  component: Shell,
  parameters: {
    layout: 'fullscreen',
    tauri: { settings: sharedSettings, commands: sharedCommands },
  },
  beforeEach: async () => {
    // Captures must not land mid-transition; the saved switch stays on so Appearance shows the default.
    setMotionEnabled(false)
    // A notice that requires a far-future app version keeps the Home banner out of the frame.
    const previousNotice = localStorage.getItem('__devNotice')
    localStorage.setItem('__devNotice', JSON.stringify({
      id: 'readme-no-notice',
      level: 'info',
      title: 'none',
      minVersion: '999.0.0',
    }))
    await setAiEnabled(true)
    await initProviderFromStore()
    // Lets a capture script check that no page hit an unmocked Tauri command.
    const journalWindow = window as Window & { __readmeJournal?: typeof getTauriJournal }
    journalWindow.__readmeJournal = getTauriJournal
    return () => {
      delete journalWindow.__readmeJournal
      if (previousNotice === null) localStorage.removeItem('__devNotice')
      else localStorage.setItem('__devNotice', previousNotice)
    }
  },
} satisfies Meta<typeof Shell>

export default meta
type Story = StoryObj<typeof meta>

export const HomeScreen: Story = {
  args: { children: <Home /> },
  parameters: { router: { initialEntries: ['/'] } },
}

export const VoiceEngine: Story = {
  args: { children: <VoiceEnginePage /> },
  parameters: { router: { initialEntries: ['/voice-engine'] } },
}

export const AiProcessing: Story = {
  args: { children: <AIInstructionsPage /> },
  parameters: { router: { initialEntries: ['/ai-instructions'] } },
}

export const AiProviders: Story = {
  args: { children: <AIServicePage /> },
  parameters: { router: { initialEntries: ['/ai-service'] } },
}

export const HistoryScreen: Story = {
  args: { children: <History /> },
  parameters: { router: { initialEntries: ['/history'] } },
}

export const Appearance: Story = {
  args: { children: <AppearancePage /> },
  parameters: { router: { initialEntries: ['/appearance'] } },
}

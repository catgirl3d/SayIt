// Brief help content for the Voice engine and AI providers pages.
//
// Provider names and console URLs are read from the provider catalogs — the same
// single source of truth the settings screens use — so a renamed provider or a moved
// console link updates the help dialog too. All sentences come from the locale files.

import { useState, type ReactNode } from 'react'
import { open as shellOpen } from '@tauri-apps/plugin-shell'
import { ChevronDown, Cloud, Cpu, Crown, ExternalLink, Server, type LucideIcon } from 'lucide-react'
import { Tooltip } from '@/components/ui/tooltip'
import type { TranslationKey } from '@/i18n'
import { RichText } from '@/i18n/RichText'
import { useT } from '@/i18n/useT'
import { aiProvidersForDisplay } from './aiProviderCatalog'
import { ASR_PLATFORMS } from './asrProviderCatalog'
import { linkClass } from './formStyles'

interface ConsoleLinkItem {
  /** Catalog id of the provider/platform, used to look up recommendation notes. */
  id: string
  name: string
  url: string
  /** Accessible name for the link, e.g. "Open the Deepgram console". */
  openLabel: string
  /** Provider catalogs mark their recommended entry; the badge reuses the same label as local models. */
  recommended?: boolean
  /** Explicit position below the recommended entries; see AsrPlatformInfo.helpRank. */
  helpRank?: number
}

// Mode rows reuse the same icons as the sidebar mode indicator and the work-mode cards,
// so "Cpu = local, Cloud = cloud API, Server = server" stays one visual language.
const MODES: { icon: LucideIcon; labelKey: TranslationKey; descKey: TranslationKey }[] = [
  { icon: Server, labelKey: 'mode.server', descKey: 'help.voiceEngine.serverDesc' },
  { icon: Cloud, labelKey: 'mode.cloudApi', descKey: 'help.voiceEngine.cloudApiDesc' },
  { icon: Cpu, labelKey: 'mode.local', descKey: 'help.voiceEngine.localDesc' },
]

// Explanation bullets for the recommended entries, keyed by catalog id. Clicking the
// entry name in the list expands them; the same notes apply in both help dialogs.
const RECOMMENDED_NOTES: Record<string, TranslationKey[]> = {
  groq: ['help.groq.free', 'help.groq.fast', 'help.groq.oneKey'],
  deepgram: ['help.deepgram.credit', 'help.deepgram.models'],
}

const ASR_RECOMMENDED_MODELS: Record<string, string[]> = {
  groq: ['whisper-large-v3', 'whisper-large-v3-turbo'],
}

const AI_RECOMMENDED_MODELS: Record<string, string[]> = {
  groq: ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'],
}

function HelpSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h4 className="mb-2 text-sm font-medium text-foreground">{title}</h4>
      <div className="space-y-2 text-sm leading-relaxed text-muted-foreground">{children}</div>
    </section>
  )
}

// Recommended entries come first; entries with an explicit helpRank follow in rank
// order; everything else keeps catalog order.
function helpOrder(items: ConsoleLinkItem[]): ConsoleLinkItem[] {
  const group = (item: ConsoleLinkItem) => (item.recommended ? 0 : 1)
  const rank = (item: ConsoleLinkItem) => item.helpRank ?? Number.MAX_SAFE_INTEGER
  return [...items].sort((a, b) => group(a) - group(b) || rank(a) - rank(b))
}

function ConsoleLinks({
  items,
  modelsMap,
}: {
  items: ConsoleLinkItem[]
  modelsMap?: Record<string, string[]>
}) {
  const t = useT()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
      {items.map((item) => {
        const notes = item.recommended ? RECOMMENDED_NOTES[item.id] ?? [] : []
        const models = item.recommended && modelsMap ? modelsMap[item.id] ?? [] : []
        const open = (notes.length > 0 || models.length > 0) && expandedId === item.id
        // Same marker as recommended local models: an amber crown with a tooltip.
        // The word itself stays out of the row so two recommended entries do not
        // repeat an identical pill; the expandable notes carry the explanation.
        const crown = item.recommended && (
          <Tooltip content={t('local.recommended')}>
            <span
              className="inline-flex shrink-0 cursor-help items-center text-amber-500"
              aria-label={t('local.recommended')}
            >
              <Crown className="h-3.5 w-3.5" aria-hidden />
            </span>
          </Tooltip>
        )
        return (
          <li key={item.id}>
            <div className="flex items-center gap-3 px-3 py-2">
              {notes.length > 0 || models.length > 0 ? (
                <button
                  type="button"
                  aria-expanded={open}
                  onClick={() => setExpandedId(open ? null : item.id)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left text-foreground transition-colors hover:text-primary"
                >
                  <ChevronDown
                    className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`}
                    aria-hidden
                  />
                  <span className="truncate font-medium">{item.name}</span>
                  {crown}
                </button>
              ) : (
                <span className="flex min-w-0 flex-1 items-center gap-2 text-foreground">
                  <span className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate font-medium">{item.name}</span>
                </span>
              )}
              <button
                type="button"
                aria-label={item.openLabel}
                onClick={() => void shellOpen(item.url)}
                className={`${linkClass} shrink-0`}
              >
                {t('help.openConsole')}
                <ExternalLink className="h-3 w-3" aria-hidden />
              </button>
            </div>
            {open && (
              <div className="space-y-2 bg-muted/20 py-2.5 pr-3 pl-[34px] text-xs leading-relaxed text-muted-foreground">
                {notes.length > 0 && (
                  <ul className="space-y-1">
                    {notes.map((key) => (
                      <li key={key}><RichText text={t(key)} /></li>
                    ))}
                  </ul>
                )}
                {models.length > 0 && (
                  <div className="space-y-1.5 border-t border-border/50 pt-2">
                    {/* A plain caption, not a pill: next to the model chips a pill reads as one more value. */}
                    <p id={`recommended-models-${item.id}`} className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Crown className="h-3 w-3 text-amber-500" aria-hidden />
                      {t('help.recommendedModels')}
                    </p>
                    {/* Information only, so the chips are borderless tags instead of button-like boxes. */}
                    <ul aria-labelledby={`recommended-models-${item.id}`} className="flex flex-wrap gap-1.5">
                      {models.map((model) => (
                        <li
                          key={model}
                          className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-muted px-2 py-0.5 font-mono text-[11px] text-foreground"
                        >
                          <span className="truncate" title={model}>{model}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function VoiceEngineHelpContent() {
  const t = useT()
  // Platforms without a console page are skipped: the OpenAI-compatible "custom"
  // entry has no console of its own.
  const platforms = helpOrder(
    Object.entries(ASR_PLATFORMS)
      .filter(([, platform]) => platform.consoleUrl !== '')
      .map(([id, platform]) => ({
        id,
        name: platform.label,
        url: platform.consoleUrl,
        openLabel: t('asr.openConsole', { platform: platform.label }),
        recommended: platform.recommended,
        helpRank: platform.helpRank,
      })),
  )

  return (
    <>
      <HelpSection title={t('help.voiceEngine.modesTitle')}>
        <div className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/70">
          {MODES.map(({ icon: Icon, labelKey, descKey }) => (
            <div key={labelKey} className="flex items-start gap-2.5 p-3">
              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t(labelKey)}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(descKey)}</p>
              </div>
            </div>
          ))}
        </div>
      </HelpSection>
      <HelpSection title={t('help.voiceEngine.keysTitle')}>
        <p><RichText text={t('help.voiceEngine.pick')} /></p>
        <ConsoleLinks items={platforms} modelsMap={ASR_RECOMMENDED_MODELS} />
      </HelpSection>
    </>
  )
}

export function AiServiceHelpContent() {
  const t = useT()
  // Providers without a console page (Ollama, the generic OpenAI-compatible entry)
  // are covered by the note below the list instead of a dead link.
  const providers = helpOrder(
    aiProvidersForDisplay().flatMap((provider) =>
      provider.consoleUrl
        ? [{
            id: provider.value,
            name: provider.label,
            url: provider.consoleUrl,
            openLabel: t('ai.openConsole', { provider: provider.label }),
            recommended: provider.recommended,
          }]
        : [],
    ),
  )

  return (
    <>
      <p className="text-sm leading-relaxed text-muted-foreground">
        <RichText text={t('help.aiService.intro')} />
      </p>
      <HelpSection title={t('help.aiService.keysTitle')}>
        <ConsoleLinks items={providers} modelsMap={AI_RECOMMENDED_MODELS} />
        <p className="text-xs text-muted-foreground/80">
          <RichText text={t('help.aiService.noKeyNote')} />
        </p>
      </HelpSection>
    </>
  )
}

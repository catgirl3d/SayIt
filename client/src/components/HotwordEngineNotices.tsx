import { useNavigate } from 'react-router-dom'
import { Feedback } from '@/components/ui/feedback'
import { RichText } from '@/i18n/RichText'
import { useT } from '@/i18n/useT'
import { foldHotwordDelivery, type AsrHotwordCapability } from '@/lib/asrModels'
import { HOTWORD_TOKEN_BUDGET } from '@/services/hotwords/budget'
import type { DictationHotwordEngine } from '@/services/hotwords/activeEngine'
import { deepgramHotwordNotice } from '@/services/hotwords/deepgramNotice'

interface HotwordEngineNoticesProps {
  /** The engine dictation uses; null until it is resolved or while no ASR service is configured. */
  engine: DictationHotwordEngine | null
  /** The Rust hotword capability matrix; empty until it is loaded. */
  capabilities: Record<string, AsrHotwordCapability>
  /** Token estimate of the active hotword list. */
  hotwordTokens: number
}

/**
 * States when dictation will not apply the hotword list the way the user expects: the engine does
 * not send hotwords to speech recognition at all, or Deepgram is gated behind a profile opt-in or
 * over its token budget. Renders nothing while the engine or the matrix is unresolved, and for
 * engines the matrix does not know, so no verdict is ever claimed without evidence.
 */
export default function HotwordEngineNotices({ engine, capabilities, hotwordTokens }: HotwordEngineNoticesProps) {
  const t = useT()
  const navigate = useNavigate()
  if (engine === null) return null

  const capability = capabilities[engine.capabilityKey]
  const engineIgnoresHotwords = capability !== undefined && foldHotwordDelivery(capability.delivery) === 'not_sent'
  const engineLabel = engine.mode === 'cloud_api'
    ? engine.providerLabel
    : t(engine.mode === 'local' ? 'mode.local' : 'mode.server')
  const deepgramNotice = deepgramHotwordNotice({
    provider: engine.capabilityKey,
    keytermsEnabled: engine.deepgramKeytermsEnabled,
    tokenEstimate: hotwordTokens,
  })

  return (
    <>
      {engineIgnoresHotwords && (
        <Feedback
          tone="warning"
          className="mb-4"
          message={(
            <RichText
              text={t('hotwords.engineIgnores', {
                engine: engineLabel,
                toggle: t('hotwordInject.title'),
                page: t('nav.aiInstructions'),
              })}
            />
          )}
        />
      )}
      {deepgramNotice === 'deepgramGate' && (
        <Feedback
          tone="warning"
          className="mb-4"
          message={t('hotwords.deepgramGate', { option: t('asr.deepgramKeyterms') })}
          actions={[{ label: t('common.openVoiceEngine'), onClick: () => navigate('/voice-engine') }]}
        />
      )}
      {deepgramNotice === 'deepgramTokenBudget' && (
        <Feedback
          tone="warning"
          className="mb-4"
          message={t('hotwords.deepgramBudget', { tokens: hotwordTokens, budget: HOTWORD_TOKEN_BUDGET })}
        />
      )}
    </>
  )
}

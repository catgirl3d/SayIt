import { HOTWORD_TOKEN_BUDGET } from './budget'

export type DeepgramHotwordNotice = 'deepgramGate' | 'deepgramTokenBudget'

/**
 * Why Deepgram will not apply the hotword list: the capability matrix reports Deepgram as sending
 * hotwords, but only when the active profile opted in (billable), and Deepgram rejects a list over
 * its token budget, after which SayIt retries without any terms. Returns null for every other
 * provider and when the list is applied. Both the Files page plan and the Hotwords page use it.
 */
export function deepgramHotwordNotice({
  provider,
  keytermsEnabled,
  tokenEstimate,
}: {
  provider: string | null
  keytermsEnabled: boolean
  tokenEstimate: number
}): DeepgramHotwordNotice | null {
  if (provider !== 'deepgram') return null
  if (!keytermsEnabled) return 'deepgramGate'
  return tokenEstimate > HOTWORD_TOKEN_BUDGET ? 'deepgramTokenBudget' : null
}

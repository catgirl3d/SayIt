import { collectAllSourceWords, composeHotwords, type CustomTheme } from './model'

/**
 * Deepgram rejects a request whose keyterms exceed 500 tokens in total, and SayIt then retries
 * without any keyterms, so this is the budget that must not be overrun.
 */
export const HOTWORD_TOKEN_BUDGET = 500

/** Gemini and the Qwen audio stream take only the first 100 words and drop the rest. */
export const HOTWORD_WORD_BUDGET = 100

/**
 * Rough token count of a hotword list. Provider tokenizers are not public, so this is a heuristic:
 * about three characters per token for ASCII terms and two for non-ASCII ones (Cyrillic and other
 * scripts split into more tokens), with every term costing at least one token.
 */
export function estimateHotwordTokens(words: string[]): number {
  let total = 0
  for (const word of words) {
    const term = word.trim()
    if (!term) continue
    const charsPerToken = /^[\x20-\x7e]*$/.test(term) ? 3 : 2
    total += Math.max(1, Math.ceil(term.length / charsPerToken))
  }
  return total
}

/** The manager state that determines the composed active hotword list. */
export interface HotwordBudgetState {
  hotwords: string[]
  builtinSetWords: Record<string, string[]>
  builtinSetActive: Record<string, boolean>
  customThemes: CustomTheme[]
  customThemeActive: Record<string, boolean>
}

/**
 * Composes the active list that results from flipping built-in set `key`. Words that belong to no
 * source (legacy uncategorized terms) are preserved ahead of the composed sources, exactly as the
 * manager does when it toggles a set, so the projection matches what the toggle will store.
 */
export function composeWithBuiltinSetToggled(state: HotwordBudgetState, key: string): string[] {
  const currentAllSourceWords = collectAllSourceWords(state.builtinSetWords, state.customThemes)
  const preservedWords = state.hotwords.filter((w) => !currentAllSourceWords.has(w))
  return composeHotwords(
    preservedWords,
    state.builtinSetWords,
    { ...state.builtinSetActive, [key]: !state.builtinSetActive[key] },
    state.customThemes,
    state.customThemeActive,
  )
}

/**
 * Whether flipping built-in set `key` is allowed under the token budget. Only switching a set ON
 * is ever refused: switching it OFF always fits, because it can only shrink the list.
 * The projection counts the estimate of the composed list, so custom categories and words
 * shared between sets are included, and words shared between sets are counted once.
 */
export function builtinSetActivationFits(state: HotwordBudgetState, key: string): boolean {
  if (state.builtinSetActive[key]) return true
  return estimateHotwordTokens(composeWithBuiltinSetToggled(state, key)) <= HOTWORD_TOKEN_BUDGET
}

/**
 * Maps each inactive built-in set key to whether switching it ON is blocked. Active sets are left
 * out, because they can always be switched off.
 */
export function getBlockedBuiltinSets(state: HotwordBudgetState, keys: string[]): Record<string, boolean> {
  const blocked: Record<string, boolean> = {}
  for (const key of keys) {
    if (state.builtinSetActive[key]) continue
    blocked[key] = !builtinSetActivationFits(state, key)
  }
  return blocked
}
/**
 * Whether adding `word` to a custom category keeps the active list within the token budget. An
 * inactive category adds nothing to the active list, so anything fits there. The estimate is a sum
 * over unique words, so a word that is already active costs nothing either.
 */
export function termAdditionFits(
  categoryActive: boolean,
  activeWords: ReadonlySet<string>,
  activeTokens: number,
  word: string,
): boolean {
  if (!categoryActive || activeWords.has(word)) return true
  return activeTokens + estimateHotwordTokens([word]) <= HOTWORD_TOKEN_BUDGET
}

import { api } from './client'

export interface HistoryListQuery {
  keyword?: string
  favoriteOnly?: boolean
  limit?: number
  offset?: number
}

export interface HistoryRecord {
  id: string
  timestamp: number
  asrText: string
  llmText: string
  asrMs: number
  llmMs: number
  durationSec: number
  audioDurationSec?: number
  asrDurationSec?: number
  charCount: number
  favorite?: boolean
  isEmpty?: boolean  // true if no valid audio/text
  /**
   * 这条为什么没出文本（仅 isEmpty 记录有）。
   *
   * 「无有效声音」这个结果有很多种成因：用户真的没说话、供应商额度耗尽、资源未开通、
   * 服务端提前断连、文本后处理失败。以前这些一律显示成同一句话，用户和我们都只能猜。
   * 这里存的是可以直接给用户看的一句话，展开详情时显示。
   *
   * 老记录没有这个字段，渲染处必须容错。
   */
  failReason?: string
  /** 新记录保存稳定分类，展示时再翻译；没有该字段的老记录继续显示 failReason 原文。 */
  failReasonCode?: HistoryFailReasonCode
  audioFilePath?: string
  appId?: string
  appName?: string
  // 录音时聚焦窗口的原始信息（用于反馈排错）
  windowTitle?: string
  processName?: string
  windowClass?: string
  promptPresetId?: string
  promptPresetName?: string
  promptRuleId?: string
  promptSummary?: string
  styleSummary?: string
  autoAppliedHotwords?: string[]
  manualEditedAt?: number
  /**
   * 已提交的 ASR 纠错编号（见 services/asrCorrection.ts）。有值即代表这条提交过，
   * 入口显示成「已提交」而不是再让用户提交一遍。
   *
   * 允许 null 不是随手写的：撤回时要把这几个字段清掉，而 `updateHistoryRecord`
   * 的 patch 会过一次 JSON.stringify —— **值为 undefined 的键会被整个丢掉**，
   * 于是"清空"变成"什么都没做"，本地永远显示已提交。必须显式写 null。
   */
  asrCorrectionId?: string | null
  asrCorrectionSubmittedAt?: number | null
  /** 用户当时给出的正确文本。本地留一份，方便回看自己改了什么。 */
  asrCorrectedText?: string | null
  // 推理来源信息
  workMode?: 'server' | 'cloud_api' | 'local'
  asrProvider?: string   // 例如 "server" / "doubao" / "sensevoice-small"
  // Null clears stale attribution in JSON-merged history patches; undefined is omitted by JSON.stringify.
  aiProvider?: string | null    // 例如 "server" / "openai_compat" / "ollama"
  aiModel?: string | null       // 例如 "deepseek-chat" / "qwen2.5:7b"
  aiSource?: 'server' | 'custom' | 'none'
  aiStatus?: 'applied' | 'skipped' | 'unavailable' | 'failed'
}

export type HistoryFailReasonCode =
  | 'no_transcript'
  | 'empty_after_processing'
  | 'processing_timeout'
  | 'provider_timeout'
  | 'provider_unreachable'
  | 'provider_bad_key'
  | 'provider_insufficient_balance'
  | 'provider_forbidden'
  | 'provider_rate_limit'
  | 'provider_no_model'
  | 'provider_failed'

export async function getHistory(): Promise<HistoryRecord[]> {
  return listHistory()
}

// Fail loud: the owning UI must distinguish an unavailable history from an empty one.
export async function listHistory(query: HistoryListQuery = {}): Promise<HistoryRecord[]> {
  const records = await api().historyList(query)
  return (records as HistoryRecord[]) || []
}

export async function countHistory(query: Omit<HistoryListQuery, 'limit' | 'offset'> = {}): Promise<number> {
  return api().historyCount(query)
}

export async function addHistory(record: HistoryRecord): Promise<void> {
  await api().historyAdd(record)
}

export async function deleteHistory(id: string): Promise<void> {
  await api().historyDelete(id)
}

export async function updateHistoryRecord(id: string, patch: Partial<HistoryRecord>): Promise<void> {
  await api().historyUpdate(id, patch as Record<string, unknown>)
}

export async function setHistoryFavorite(id: string, favorite: boolean): Promise<void> {
  await api().historySetFavorite(id, favorite)
}

export async function clearHistory(): Promise<void> {
  await api().historyClear()
}

export async function getFavoriteHistory(): Promise<HistoryRecord[]> {
  return listHistory({ favoriteOnly: true })
}

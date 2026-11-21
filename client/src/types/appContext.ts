export interface TextContext {
  source: string
  textBefore: string
  selectedText: string
  textAfter: string
  selectionTruncated: boolean
}

/** Native capture diagnostics: a reason code and timings only, never editor text. */
export interface TextContextDiag {
  result: string
  depth?: number
  elapsedMs: number
}

export interface ActiveAppContext {
  reason?: string
  timestamp?: number
  hwnd?: string
  pid?: number
  tid?: number
  processName?: string
  exePath?: string
  windowTitle?: string
  windowClass?: string
  focusHwnd?: string
  caretHwnd?: string
  hasCaret?: boolean
  focusClass?: string
  controlType?: string
  automationId?: string
  focusedName?: string
  automationProcessId?: number
  isValuePatternAvailable?: boolean
  isTextPatternAvailable?: boolean
  isTextPattern2Available?: boolean
  isTextEditPatternAvailable?: boolean
  isKeyboardFocusable?: boolean
  hasKeyboardFocus?: boolean
  isEnabled?: boolean
  isOffscreen?: boolean
  isReadOnly?: boolean
  isPassword?: boolean
  isCurrentAppProcess?: boolean
  /** Only populated for a recording when context-aware writing is explicitly enabled. */
  textContext?: TextContext
  /** Present when text capture was requested, whether it succeeded or not. */
  textContextDiag?: TextContextDiag
}

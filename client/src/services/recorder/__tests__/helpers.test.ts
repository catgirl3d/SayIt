import { afterEach, describe, it, expect, vi } from 'vitest'
import {
  summarizeAppContext,
  buildStatsAppId,
  isModifierPTTSetting,
  computeProcessingTimeoutMs,
  classifyMicLevel,
  judgeOsMicMute,
  createHistoryRecordId,
  MIC_NO_SIGNAL_PEAK_THRESHOLD,
  MIC_LOW_RMS_THRESHOLD,
  OS_MIC_MUTE_CONFIRM_SAMPLES,
} from '../helpers'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('judgeOsMicMute', () => {
  // Regression: the Plantronics Blackwire 5220 stays at GetMute=true while audio flows normally;
  // trusting the system flag would falsely report "microphone muted" on every hotkey press.
  it('drops the system mute flag immediately while audio is flowing', () => {
    expect(judgeOsMicMute(0, 'voiced', 1600)).toEqual({ verdict: 'dismissed' })
    expect(judgeOsMicMute(0, 'low', 1600)).toEqual({ verdict: 'dismissed' })
  })

  it('lets one non-zero frame override the flag even just below the confirmation threshold', () => {
    expect(judgeOsMicMute(OS_MIC_MUTE_CONFIRM_SAMPLES - 1, 'low', 1600))
      .toEqual({ verdict: 'dismissed' })
  })

  it('keeps accumulating all-zero samples below the threshold without alerting', () => {
    expect(judgeOsMicMute(0, 'muted', 1600)).toEqual({ verdict: 'wait', silentSamples: 1600 })
    expect(judgeOsMicMute(1600, 'muted', 1600)).toEqual({ verdict: 'wait', silentSamples: 3200 })
  })

  it('confirms a real mute only once all-zero samples reach the threshold', () => {
    expect(judgeOsMicMute(OS_MIC_MUTE_CONFIRM_SAMPLES - 1600, 'muted', 1600))
      .toEqual({ verdict: 'confirmed' })
  })
})

describe('classifyMicLevel', () => {
  it('classifies muted only when the PCM peak is strictly zero', () => {
    expect(classifyMicLevel(0, 0)).toBe('muted')
    expect(classifyMicLevel(0.05, MIC_NO_SIGNAL_PEAK_THRESHOLD)).toBe('muted')
  })

  it('classifies any non-zero input as low however small', () => {
    expect(classifyMicLevel(Number.MIN_VALUE, Number.MIN_VALUE)).toBe('low')
    expect(classifyMicLevel(0.004, 0.05)).toBe('low')
    expect(classifyMicLevel(MIC_LOW_RMS_THRESHOLD - 0.0001, 1 / 32768)).toBe('low')
  })

  it('classifies a normal RMS level as voiced', () => {
    expect(classifyMicLevel(0.03, 0.2)).toBe('voiced')
    expect(classifyMicLevel(MIC_LOW_RMS_THRESHOLD, 0.1)).toBe('voiced')
  })
})

describe('summarizeAppContext', () => {
  it('returns null for null', () => {
    expect(summarizeAppContext(null)).toBeNull()
  })

  it('extracts the key fields', () => {
    const result = summarizeAppContext({
      processName: 'code.exe',
      exePath: 'C:\\Program Files\\Code\\code.exe',
      windowTitle: 'secret-doc.md',
      windowClass: 'Chrome_WidgetWin_1',
      focusClass: 'Chrome_RenderWidgetHostHWND',
      controlType: 'Edit',
    })
    expect(result?.processName).toBe('code.exe')
    expect(result?.windowTitle).toBe('secret-doc.md')
  })
})

describe('buildStatsAppId', () => {
  it('prefers processName', () => {
    expect(buildStatsAppId({ processName: 'code.exe' })).toBe('code.exe')
  })

  it('falls back to the last exePath segment when processName is empty', () => {
    expect(buildStatsAppId({ exePath: 'C:\\Apps\\notepad.exe' })).toBe('notepad.exe')
  })

  it('falls back to promptAppId when both are empty', () => {
    expect(buildStatsAppId(null, 'my-app')).toBe('my-app')
  })

  it('returns unknown when everything is empty', () => {
    expect(buildStatsAppId(null)).toBe('unknown')
  })
})

describe('isModifierPTTSetting', () => {
  it('accepts a lone modifier and any modifier inside a combo', () => {
    expect(isModifierPTTSetting('AltLeft')).toBe(true)
    expect(isModifierPTTSetting('ControlRight')).toBe(true)
    expect(isModifierPTTSetting('ShiftLeft')).toBe(true)
    expect(isModifierPTTSetting('ControlLeft+KeyK')).toBe(true)
    expect(isModifierPTTSetting('ControlLeft+MetaLeft')).toBe(true)
  })

  it('returns false for non-modifier keys', () => {
    expect(isModifierPTTSetting('Space')).toBe(false)
    expect(isModifierPTTSetting('F1')).toBe(false)
    expect(isModifierPTTSetting('KeyK')).toBe(false)
    expect(isModifierPTTSetting(undefined)).toBe(false)
  })
})

describe('computeProcessingTimeoutMs', () => {
  it('server mode: base timeout', () => {
    const ms = computeProcessingTimeoutMs(5, 'server')
    expect(ms).toBeGreaterThanOrEqual(15000)
    expect(ms).toBeLessThan(20000)
  })

  it('cloud_api mode: at least 30s', () => {
    const ms = computeProcessingTimeoutMs(1, 'cloud_api')
    expect(ms).toBeGreaterThanOrEqual(30000)
  })

  it('local mode: at least 30s', () => {
    const ms = computeProcessingTimeoutMs(1, 'local')
    expect(ms).toBeGreaterThanOrEqual(30000)
  })

  it('gives longer audio a longer timeout', () => {
    const short = computeProcessingTimeoutMs(5, 'server')
    const long = computeProcessingTimeoutMs(60, 'server')
    expect(long).toBeGreaterThan(short)
  })

  it('cloud_api mode: capped at 90s', () => {
    const ms = computeProcessingTimeoutMs(600, 'cloud_api')
    expect(ms).toBeLessThanOrEqual(90000)
  })
})

describe('createHistoryRecordId', () => {
  it('creates distinct ids within the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.123456).mockReturnValueOnce(0.654321)

    expect(createHistoryRecordId()).not.toBe(createHistoryRecordId())
  })
})

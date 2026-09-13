import { describe, expect, it } from 'vitest'
import {
  canonicalizePTTShortcut,
  displayPTTShortcut,
  getAcceleratorShortcutValidationError,
  getPTTShortcutWarning,
  getPTTShortcutValidationError,
  isValidPTTShortcut,
  parsePTTShortcut,
  PTT_CODE_TO_VK,
  pttShortcutConflictsWithAccelerator,
  pttShortcutHasModifier,
  pttShortcutToAccelerator,
  resolveDictationTrigger,
} from '../shortcutKeys'

describe('PTT 物理组合键', () => {
  it('保留左右位置并按固定顺序规范化', () => {
    const value = canonicalizePTTShortcut('ShiftRight+KeyK+MetaLeft+ControlLeft')
    expect(value).toBe('ControlLeft+MetaLeft+ShiftRight+KeyK')
    expect(parsePTTShortcut(value)).toEqual([
      'ControlLeft',
      'MetaLeft',
      'ShiftRight',
      'KeyK',
    ])
    expect(displayPTTShortcut('ControlLeft+MetaLeft')).toEqual(['Left Ctrl', 'Left Win'])
  })

  it('兼容旧单键，并接受普通组合与纯修饰组合', () => {
    // 这里原来用 ShiftRight 当旧单键的样例，现在 Shift 已被 PTT 禁用（见下方专门的用例），
    // 换成同样是"旧单键"的右 Alt / CapsLock
    expect(isValidPTTShortcut('AltRight')).toBe(true)
    expect(isValidPTTShortcut('CapsLock')).toBe(true)
    expect(isValidPTTShortcut('MButton')).toBe(true)
    expect(isValidPTTShortcut('ControlLeft+KeyK')).toBe(true)
    expect(isValidPTTShortcut('ControlLeft+MetaLeft')).toBe(true)
    expect(pttShortcutHasModifier('ControlLeft+KeyK')).toBe(true)
    expect(PTT_CODE_TO_VK.MetaLeft).toBe(0x5b)
    expect(PTT_CODE_TO_VK.KeyK).toBe(0x4b)
  })

  it('supports F1 through F24 as single-key shortcuts', () => {
    for (let n = 1; n <= 24; n += 1) {
      const code = `F${n}`
      expect(PTT_CODE_TO_VK[code], `${code} must be in the shortcut table`).toBe(0x70 + n - 1)
      expect(isValidPTTShortcut(code), `${code} must be valid as a single key`).toBe(true)
    }
    expect(displayPTTShortcut('F13')).toEqual(['F13'])
    expect(displayPTTShortcut('F24')).toEqual(['F24'])
    expect(isValidPTTShortcut('ControlLeft+F13')).toBe(true)
    expect(isValidPTTShortcut('AltLeft+F13')).toBe(true)
    expect(getPTTShortcutValidationError('AltLeft+F4')).not.toBeNull()
  })

  it('拒绝单独 Win、裸字母、多主键和危险系统组合', () => {
    expect(getPTTShortcutValidationError('MetaLeft')).toContain("can't be used on its own")
    expect(getPTTShortcutValidationError('KeyK')).toContain("can't be used on their own")
    expect(getPTTShortcutValidationError('ControlLeft+KeyK+KeyL')).toContain('only one')
    expect(getPTTShortcutValidationError('ControlLeft+ControlRight+KeyK')).toContain('left and right')
    expect(getPTTShortcutValidationError('MetaLeft+KeyL')).toContain('reserved by the system')
    expect(getPTTShortcutValidationError('AltLeft+F4')).toContain('system combination')
    expect(getPTTShortcutValidationError('MetaLeft+KeyK')).not.toBeNull()
    expect(getPTTShortcutValidationError('AltLeft+Space')).not.toBeNull()
    expect(isValidPTTShortcut('ControlLeft+MetaLeft')).toBe(true)
  })

  // 原来是「提示风险但仍允许保存」。警告挡不住任何人：用户照样绑了右 Shift，
  // 照样踩到筛选键让录音停不下来。现在改成硬拦。
  it('按住说话一律拒绝 Shift，单键和组合成员都算', () => {
    expect(isValidPTTShortcut('ShiftRight')).toBe(false)
    expect(isValidPTTShortcut('ShiftLeft')).toBe(false)
    expect(isValidPTTShortcut('ControlLeft+ShiftRight')).toBe(false)
    expect(isValidPTTShortcut('ShiftLeft+KeyK')).toBe(false)
    expect(getPTTShortcutValidationError('ShiftRight')).toContain('Shift')
    // 别的修饰键不受影响
    expect(isValidPTTShortcut('AltRight')).toBe(true)
    expect(isValidPTTShortcut('ControlLeft+KeyK')).toBe(true)
  })

  // 老用户可能在 Shift 还能选的时候绑上了它：旧绑定继续生效，但要在设置里提示改绑。
  // 升级时静默换掉用户的说话键，或者让它突然失效，都比留一行提示更糟。
  it('已保存的 Shift 旧配置给出改绑提示', () => {
    expect(getPTTShortcutWarning('ShiftRight')).toContain('Shift')
    expect(getPTTShortcutWarning('ControlLeft+ShiftLeft')).toContain('Shift')
    expect(getPTTShortcutWarning('AltRight')).toBeNull()
  })

  // Shift 只在「按住说话」里有问题（要长按、会连按）。免提这类按一下的快捷键照旧可用。
  it('按一下的快捷键不受 Shift 限制', () => {
    expect(getAcceleratorShortcutValidationError('CommandOrControl+Shift+K')).toBeNull()
  })

  it('通用组合键同样拒绝 Windows 保留快捷键', () => {
    expect(getAcceleratorShortcutValidationError('Control+Alt+Delete')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Alt+Tab')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Alt+Space')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Control+Shift+Escape')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('Super+K')).not.toBeNull()
    expect(getAcceleratorShortcutValidationError('CommandOrControl+K')).toBeNull()
  })

  it('可与免提 accelerator 做语义冲突比较', () => {
    expect(pttShortcutToAccelerator('ControlLeft+KeyK')).toBe('CommandOrControl+K')
    expect(
      pttShortcutConflictsWithAccelerator('ControlLeft+KeyK', 'CommandOrControl+K'),
    ).toBe(true)
    expect(pttShortcutConflictsWithAccelerator('ShiftRight', 'ShiftRight')).toBe(true)
    expect(
      pttShortcutConflictsWithAccelerator('ControlLeft+MetaLeft', 'ControlLeft'),
    ).toBe(true)
    expect(
      pttShortcutConflictsWithAccelerator('ControlLeft+MetaLeft', 'CommandOrControl+K'),
    ).toBe(false)
  })
})

describe('实际触发键的解析', () => {
  it('免提与按住说话都绑定时以免提为准', () => {
    expect(resolveDictationTrigger('AltRight', 'ControlRight')).toEqual({
      mode: 'handsFree',
      keyLabels: ['Right Alt'],
    })
  })

  // 回归：首页原来只读免提键，而空字符串是**合法**的已保存值（用户手动清空过），
  // getSetting 的默认值不会兜底，于是句子里渲染出一个空键帽。
  it('免提被清空时回退到已绑定的按住说话键', () => {
    const trigger = resolveDictationTrigger('', 'AltRight')
    expect(trigger.mode).toBe('ptt')
    expect(trigger.keyLabels).toEqual(['Right Alt'])
  })

  it('按住说话组合键经共享键表翻译成键帽', () => {
    expect(resolveDictationTrigger('   ', 'ControlLeft+KeyK')).toEqual({
      mode: 'ptt',
      keyLabels: ['Left Ctrl', 'K'],
    })
  })

  it('两者都未绑定时报告 none 且没有键帽', () => {
    expect(resolveDictationTrigger('', '')).toEqual({ mode: 'none', keyLabels: [] })
  })

  // Rust 的 ptt_key_config() 对非法值静默回退到 ControlRight；界面不能把原始字符串
  // 当成用户实际按得响的键展示出来。
  it('非法的按住说话值不算已绑定，旧 Shift 绑定仍然照常显示', () => {
    expect(resolveDictationTrigger('', 'ControlLeft+ControlRight')).toEqual({ mode: 'none', keyLabels: [] })
    expect(resolveDictationTrigger('', 'NotAKey')).toEqual({ mode: 'none', keyLabels: [] })
    expect(resolveDictationTrigger('', 'ShiftRight').mode).toBe('ptt')
  })

  it('只要报告了模式，键帽列表就不为空', () => {
    // 界面直接拿 keyLabels 渲染键帽；非空保证提示句里不会再出现空白键帽。
    for (const [handsFree, ptt] of [
      ['AltRight', 'ControlRight'],
      ['', 'AltRight'],
      ['Alt+L', 'ControlLeft+KeyK'],
      ['', ''],
    ] as const) {
      const trigger = resolveDictationTrigger(handsFree, ptt)
      if (trigger.mode === 'none') {
        expect(trigger.keyLabels).toEqual([])
      } else {
        expect(trigger.keyLabels.length).toBeGreaterThan(0)
      }
    }
  })
})

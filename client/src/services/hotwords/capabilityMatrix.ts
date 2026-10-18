import { invoke } from '@tauri-apps/api/core'
import type { AsrHotwordCapability } from '@/lib/asrModels'

export type AsrHotwordCapabilityMatrix = Record<string, AsrHotwordCapability>

/** Loads the Rust hotword capability matrix (provider -> delivery verdict and client cap). */
export async function loadAsrHotwordCapabilityMatrix(): Promise<AsrHotwordCapabilityMatrix> {
  const matrix = await invoke<AsrHotwordCapabilityMatrix>('asr_hotword_capability_matrix')
  if (!matrix || typeof matrix !== 'object') throw new Error('Invalid ASR hotword capability matrix')
  return matrix
}

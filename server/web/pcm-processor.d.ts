export declare class PCMResampler {
  constructor(inputRate: number, targetRate: number)
  process(input: Float32Array): { pcm: Int16Array; rms: number }
}

export declare function registerPCMProcessor(): void

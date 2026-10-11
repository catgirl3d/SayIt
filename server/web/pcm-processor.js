// Self-contained: desktop embeds this module in data/Blob worklet URLs.
export class PCMResampler {
  constructor(inputRate, targetRate) {
    this.ratio = inputRate / targetRate;
    this.tail = new Float32Array(0);
    this.phase = 0;
  }

  process(input) {
    let sum = 0;
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      sum += s * s;
    }
    const rms = Math.sqrt(sum / input.length);

    const merged = new Float32Array(this.tail.length + input.length);
    merged.set(this.tail, 0);
    merged.set(input, this.tail.length);

    let outFloat;

    if (Math.abs(this.ratio - 1) < 0.0001) {
      outFloat = merged;
      this.tail = new Float32Array(0);
      this.phase = 0;
    } else {
      const available = merged.length - this.phase;
      const outLen = Math.floor(available / this.ratio);

      if (outLen <= 0) {
        this.tail = merged;
        return { pcm: new Int16Array(0), rms };
      }

      outFloat = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = this.phase + i * this.ratio;
        const i0 = Math.floor(pos);
        const i1 = Math.min(i0 + 1, merged.length - 1);
        const frac = pos - i0;
        outFloat[i] = merged[i0] * (1 - frac) + merged[i1] * frac;
      }

      const consumed = this.phase + outLen * this.ratio;
      const keepFrom = Math.floor(consumed);
      this.phase = consumed - keepFrom;
      this.tail = keepFrom < merged.length ? merged.slice(keepFrom) : new Float32Array(0);
    }

    const pcm = new Int16Array(outFloat.length);
    for (let i = 0; i < outFloat.length; i++) {
      const s = Math.max(-1, Math.min(1, outFloat[i]));
      pcm[i] = s < 0 ? s * 32768 : s * 32767;
    }

    return { pcm, rms };
  }
}

// Worklet globals are accessed only here, never during a main-thread import.
export function registerPCMProcessor() {
  class PCMProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const opts = options.processorOptions || {};
      this.targetRate = opts.targetRate || 16000;
      const inputRate = opts.inputRate || sampleRate || 48000;
      this.resampler = new PCMResampler(inputRate, this.targetRate);
    }

    process(inputs) {
      const input = inputs[0]?.[0];
      if (!input || input.length === 0) {
        return true;
      }

      const { pcm, rms } = this.resampler.process(input);
      if (pcm.length === 0) {
        this.port.postMessage({ rms, sampleRate: this.targetRate });
      } else {
        this.port.postMessage({ pcm: pcm.buffer, rms, sampleRate: this.targetRate }, [pcm.buffer]);
      }
      return true;
    }
  }

  registerProcessor('pcm-processor', PCMProcessor);
}

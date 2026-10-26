export const primaryModelId = 'nemotron-asr-streaming-0.6b-gguf'
export const secondaryModelId = 'sensevoice-small-gguf'

export const availableModels = [
  {
    id: primaryModelId,
    name: 'Nemotron ASR Streaming',
    description: 'A multilingual streaming model for local dictation.',
    model_type: 'gguf',
    total_size_bytes: 520 * 1024 * 1024,
    languages: ['en', 'uk', 'ru', 'zh'],
    sources: [
      {
        source: 'HuggingFace',
        files: [
          {
            name: 'nemotron-asr-streaming-0.6b-Q4_K_M.gguf',
            url: 'https://models.example.test/nemotron.gguf',
            size_bytes: 520 * 1024 * 1024,
            sha256: null,
          },
        ],
      },
    ],
    speed: 8,
    accuracy: 8,
    recommended: true,
    memory_mb: 900,
    quant: 'Q4_K_M',
    featured: true,
  },
  {
    id: secondaryModelId,
    name: 'SenseVoice Small',
    description: 'A compact model optimized for fast offline recognition.',
    model_type: 'gguf',
    total_size_bytes: 310 * 1024 * 1024,
    languages: ['en', 'zh'],
    sources: [
      {
        source: 'HuggingFace',
        files: [
          {
            name: 'sensevoice-small-Q8_0.gguf',
            url: 'https://models.example.test/sensevoice.gguf',
            size_bytes: 310 * 1024 * 1024,
            sha256: null,
          },
        ],
      },
    ],
    speed: 9,
    accuracy: 7,
    memory_mb: 650,
    quant: 'Q8_0',
    featured: false,
  },
]

export const downloadedModels = [
  {
    id: primaryModelId,
    name: 'Nemotron ASR Streaming',
    model_type: 'gguf',
    total_size_bytes: 520 * 1024 * 1024,
    path: 'C:/Users/Storybook/AppData/Local/SayIt/models/nemotron',
    complete: true,
  },
]

export const diagnosticsWithGpu = {
  devices: [
    { kind: 'cpu', name: '12th Gen Intel(R) Core(TM)', memory_mb: 0 },
    { kind: 'gpu', name: 'NVIDIA RTX 4060', memory_mb: 8192 },
  ],
  current_backend: 'cuda',
  loading_model: null,
  native_version: '1.2.0',
  process_memory_mb: 1240,
}

export const diagnosticsCpuOnly = {
  devices: [{ kind: 'cpu', name: '12th Gen Intel(R) Core(TM)', memory_mb: 0 }],
  current_backend: 'cpu',
  loading_model: null,
  native_version: '1.2.0',
  process_memory_mb: 640,
}

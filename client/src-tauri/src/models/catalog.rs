// Model catalog

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadSource {
    pub source: String,
    pub files: Vec<ModelFile>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFile {
    pub name: String,
    pub url: String,
    pub size_bytes: u64,
    pub sha256: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    /// Display name, without GGUF/quantization terms (those belong in `quant` and parameter rows).
    pub name: String,
    /// One-line description/positioning; does not mix memory or language lists, which have their own fields.
    pub description: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub languages: Vec<String>,
    pub sources: Vec<DownloadSource>,
    #[serde(default)]
    pub archive_url: Option<String>,
    /// Speed rating 0-10 (decimal allowed, 10 is fastest).
    #[serde(default)]
    pub speed: f32,
    /// Accuracy rating 0-10 (decimal allowed, 10 is most accurate).
    #[serde(default)]
    pub accuracy: f32,
    /// Whether this is the recommended (default) model.
    #[serde(default)]
    pub recommended: bool,
    /// Resident memory after loading (MB, measured working set, not derived from weight size —
    /// beyond weights, autoregressive models like Qwen3 allocate KV cache and compute buffers
    /// adding ~700 MB to 1 GB. For measurement methods, see gguf_asr.rs `footprint_report`).
    #[serde(default)]
    pub memory_mb: u64,
    /// Display label for supported languages ("English" / "5 languages" / "100 languages").
    /// `languages` is used for logic; the UI label does not concatenate raw codes.
    #[serde(default)]
    pub languages_label: String,
    /// Quantization tier ("Q8_0", "Q4_K_M", etc.). Kept as metadata for offline download guidance and tooltips.
    #[serde(default)]
    pub quant: String,
    /// Whether the model is shown directly in the featured list.
    /// Fast / balanced / accurate tiers are featured; others are collapsed under "More".
    #[serde(default)]
    pub featured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalModelInfo {
    pub id: String,
    pub name: String,
    pub model_type: String,
    pub total_size_bytes: u64,
    pub path: String,
    pub complete: bool,
}

// ── Shared static language matrices ──────────────────────────────────────────
// Statically defined to eliminate duplicate heap allocations and keep the catalog
// and upstream compatibility tests synchronized.

pub const WHISPER_LANGUAGES: &[&str] = &[
    "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar",
    "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu",
    "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa",
    "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn",
    "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc",
    "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn",
    "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw",
    "su", "yue",
];

pub const QWEN3_LANGUAGES: &[&str] = &[
    "zh", "en", "yue", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th", "vi",
    "ja", "tr", "hi", "ms", "nl", "sv", "da", "fi", "pl", "cs", "fil", "fa", "el", "hu",
    "mk", "ro",
];

pub const NEMOTRON_LANGUAGES: &[&str] = &[
    // Tier 1, transcription-ready (19 locales -> 15 languages):
    "en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi", "uk",
    // Tier 2, broad-coverage (13 locales -> 13 languages):
    "pl", "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et",
    // Tier 3, adaptation-ready (8 locales -> 8 languages):
    "el", "lt", "lv", "mt", "sl", "he", "th", "nn",
];

pub const PARAKEET_V3_LANGUAGES: &[&str] = &[
    "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv",
    "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk",
];

pub const FUNASR_MLT_LANGUAGES: &[&str] = &[
    "zh", "en", "yue", "ja", "ko", "vi", "id", "th", "ms", "tl", "ar", "hi", "bg", "hr",
    "cs", "da", "nl", "et", "fi", "el", "hu", "ga", "lv", "lt", "mt", "pl", "pt", "ro",
    "sk", "sl", "sv",
];

#[inline]
fn lang_vec(langs: &[&str]) -> Vec<String> {
    langs.iter().map(|&s| s.to_string()).collect()
}

fn hf(repo: &str, file: &str) -> String {
    format!("https://huggingface.co/{}/resolve/main/{}", repo, file)
}

fn hf_mirror(repo: &str, file: &str) -> String {
    format!("https://hf-mirror.com/{}/resolve/main/{}", repo, file)
}

/// GGUF weight coordinates (repository, file name, byte size, and sha256).
/// Extracted into a struct so size and checksum are defined only once.
struct GgufWeight {
    repo: &'static str,
    file: &'static str,
    size: u64,
    sha256: &'static str,
}

impl GgufWeight {
    /// Mirror prioritized, official HuggingFace fallback. Order is significant:
    /// if `localAsr.downloadSource` does not match any source, `registry::download_model`
    /// silently falls back to the first source.
    fn sources(&self) -> Vec<DownloadSource> {
        vec![
            self.at("HuggingFace Mirror", hf_mirror(self.repo, self.file)),
            self.at("HuggingFace", hf(self.repo, self.file)),
        ]
    }

    fn at(&self, source: &str, url: String) -> DownloadSource {
        DownloadSource {
            source: source.into(),
            files: vec![ModelFile {
                name: self.file.into(),
                url,
                size_bytes: self.size,
                sha256: Some(self.sha256.into()),
            }],
        }
    }
}

/// Available local models. All models are GGUF (ggml / transcribe.cpp).
/// Legacy ONNX models were removed alongside sherpa-onnx; legacy directories are reclaimed by `local_asr::reclaim_legacy_models`.
///
/// List order = UI display order (frontend does not sort).
/// Ordered from fastest to slowest.
pub fn get_available_models() -> Vec<ModelInfo> {
    vec![
        // ── Parakeet Unified EN 0.6B GGUF (NVIDIA, parakeet family) ──
        // English-only, but simultaneously the fastest and most accurate tier for English:
        // Upstream WER (LibriSpeech test-clean) Q4_K_M = 1.62%, slightly better than Qwen3-ASR 1.7B
        // high precision (1.65%), with measured RTF 0.056 (CPU) / 0.023 (Vulkan), faster than SenseVoice (0.063).
        // Strictly dominates other models for pure English speech. Outputs empty string on non-English audio.
        // Punctuation and capitalization are inherent behaviors; ITN/PnC toggles are unsupported.
        // Numbers are normalized (e.g. "2026" instead of spoken form).
        ModelInfo {
            id: "parakeet-unified-en-0.6b-gguf".into(),
            name: "Parakeet Unified EN".into(),
            description: "The fastest and most accurate for English, English only".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: PARAKEET_UNIFIED_EN_Q4.size,
            speed: 9.0,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 900,
            featured: true,
            languages_label: "English".into(),
            quant: "Q4_K_M".into(),
            languages: lang_vec(&["en"]),
            sources: PARAKEET_UNIFIED_EN_Q4.sources(),
            archive_url: None,
        },
        // ── SenseVoice Small GGUF (ggml engine) ──
        // Punctuation is controlled via RunOptions itn=on (default is <|woitn|> branch, without punctuation).
        // Measured RTF 0.063 on 9s audio on pure CPU.
        ModelInfo {
            id: "sensevoice-small-gguf".into(),
            name: "SenseVoice Small".into(),
            description: "Very fast and ideal for everyday use".into(),
            model_type: "sensevoice-gguf".into(),
            total_size_bytes: SENSEVOICE.size,
            speed: 8.5,
            accuracy: 7.0,
            recommended: true,
            memory_mb: 350,
            featured: true,
            languages_label: "5 languages (zh, en, ja, ko, yue)".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(&["zh", "en", "ja", "ko", "yue"]),
            sources: SENSEVOICE.sources(),
            archive_url: None,
        },
        // Parakeet TDT v3 GGUF: fast multilingual European transcription.
        ModelInfo {
            id: "parakeet-tdt-0.6b-v3-gguf".into(),
            name: "Parakeet TDT v3".into(),
            description: "Fast multilingual European transcription".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: PARAKEET_TDT_V3_Q8.size,
            speed: 8.5,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 900,
            featured: true,
            languages_label: "25 European languages".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(PARAKEET_V3_LANGUAGES),
            sources: PARAKEET_TDT_V3_Q8.sources(),
            archive_url: None,
        },
        // ── Nemotron 3.5 ASR Streaming 0.6B GGUF (NVIDIA, parakeet family) ──
        // 40 language-locales across three tiers (19 transcription-ready, 13 broad-coverage, 8 adaptation-ready),
        // covering Spanish/French/German/Italian/Portuguese/Dutch/Russian/Arabic/Hindi/Turkish/Vietnamese/Ukrainian.
        // Upstream provides native punctuation and capitalization (PnC); numbers stay in spoken form.
        // Accuracy: LibriSpeech test-clean Q4_K_M 3.28% vs Parakeet 1.62%. Measured RTF 0.069 (CPU) / 0.032 (Vulkan).
        // The catalog list carries base language codes (40 locales collapse to 36 distinct languages).
        ModelInfo {
            id: "nemotron-asr-streaming-0.6b-gguf".into(),
            name: "Nemotron 3.5 ASR".into(),
            description: "The broadest language coverage, for multilingual use".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: NEMOTRON_STREAMING_Q4.size,
            speed: 8.0,
            accuracy: 7.5,
            recommended: false,
            memory_mb: 1050,
            featured: true,
            languages_label: "40 languages".into(),
            quant: "Q4_K_M".into(),
            languages: lang_vec(NEMOTRON_LANGUAGES),
            sources: NEMOTRON_STREAMING_Q4.sources(),
            archive_url: None,
        },
        // ── Sber GigaAM v3 e2e RNN-T GGUF (ggml engine, transcribe.cpp) ──
        // 220M parameter Conformer-RNNT model for Russian speech recognition.
        // Native end-to-end punctuation and capitalization (e2e), high accuracy (WER ~5.36% on Fleurs RU).
        ModelInfo {
            id: "gigaam-v3-e2e-rnnt-gguf".into(),
            name: "GigaAM v3".into(),
            description: "Highest accuracy for Russian, with built-in punctuation".into(),
            model_type: "gigaam-gguf".into(),
            total_size_bytes: GIGAAM_V3_E2E_RNNT_Q8.size,
            speed: 8.0,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 650,
            featured: true,
            languages_label: "Russian".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(&["ru"]),
            sources: GIGAAM_V3_E2E_RNNT_Q8.sources(),
            archive_url: None,
        },
        // GigaAM v3 CTC GGUF: a compact Russian-only recognizer.
        ModelInfo {
            id: "gigaam-v3-e2e-ctc-gguf".into(),
            name: "GigaAM v3 CTC".into(),
            description: "Compact Russian speech recognition".into(),
            model_type: "gigaam-gguf".into(),
            total_size_bytes: GIGAAM_V3_E2E_CTC_Q8.size,
            speed: 8.0,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 650,
            featured: false,
            languages_label: "Russian".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(&["ru"]),
            sources: GIGAAM_V3_E2E_CTC_Q8.sources(),
            archive_url: None,
        },
        // ── Fun-ASR Nano 2512 GGUF (SenseVoice encoder + Qwen3 decoder) ──
        // Developed by FunAudioLLM for zh/en/ja. Outperforms Qwen3-ASR 0.6B in speed and accuracy:
        // Upstream WER 1.79% vs 2.11%. Measured RTF 0.075, memory ~1.4 GB.
        // Approaches 1.7B accuracy in half the time and memory. Punctuation requires itn=true.
        ModelInfo {
            id: "funasr-nano-2512-gguf".into(),
            name: "Fun-ASR Nano".into(),
            description: "Fast and accurate—a balanced choice for Chinese dictation".into(),
            model_type: "funasr-nano-gguf".into(),
            total_size_bytes: FUNASR_NANO_Q8.size,
            speed: 7.5,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 1400,
            featured: true,
            languages_label: "3 languages (zh, en, ja)".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(&["zh", "en", "ja"]),
            sources: FUNASR_NANO_Q8.sources(),
            archive_url: None,
        },
        // Fun-ASR MLT Nano: broad language coverage in a compact model.
        ModelInfo {
            id: "funasr-mlt-nano-2512-gguf".into(),
            name: "Fun-ASR MLT Nano".into(),
            description: "Compact model with broad language coverage".into(),
            model_type: "funasr-nano-gguf".into(),
            total_size_bytes: FUNASR_MLT_NANO_Q8.size,
            speed: 7.5,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 1400,
            featured: false,
            languages_label: "31 languages".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(FUNASR_MLT_LANGUAGES),
            sources: FUNASR_MLT_NANO_Q8.sources(),
            archive_url: None,
        },
        // ── Qwen3-ASR 0.6B GGUF (ggml engine, transcribe.cpp) ──
        // GGUF block quantization + ggml inference: 9s Chinese audio pure CPU RTF 0.167.
        // Built-in punctuation, clean output. Upstream WER (LibriSpeech test-clean) Q8_0 = 2.11%.
        ModelInfo {
            id: "qwen3-asr-0.6b-gguf".into(),
            name: "Qwen3-ASR 0.6B".into(),
            description: "A fast, lightweight multilingual option".into(),
            model_type: "qwen3-asr-gguf".into(),
            total_size_bytes: QWEN3_06B_Q8.size,
            speed: 7.0,
            accuracy: 8.5,
            recommended: false,
            memory_mb: 1500,
            featured: false,
            languages_label: "30 languages".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(QWEN3_LANGUAGES),
            sources: QWEN3_06B_Q8.sources(),
            archive_url: None,
        },
        // Whisper Small Q4_K_M GGUF (multilingual, transcribe.cpp).
        // The lightweight Whisper tier: 100 languages, including Ukrainian.
        ModelInfo {
            id: "whisper-small-gguf".into(),
            name: "Whisper Small".into(),
            description: "Fast and lightweight option for laptops and older hardware".into(),
            model_type: "whisper-gguf".into(),
            total_size_bytes: WHISPER_SMALL_Q4.size,
            speed: 6.5,
            accuracy: 7.0,
            recommended: false,
            memory_mb: 700,
            featured: false,
            languages_label: "100 languages".into(),
            quant: "Q4_K_M".into(),
            languages: lang_vec(WHISPER_LANGUAGES),
            sources: WHISPER_SMALL_Q4.sources(),
            archive_url: None,
        },
        // Parakeet TDT 1.1B GGUF: high-accuracy English transcription.
        ModelInfo {
            id: "parakeet-tdt-1.1b-gguf".into(),
            name: "Parakeet TDT 1.1B".into(),
            description: "High-accuracy English transcription".into(),
            model_type: "parakeet-gguf".into(),
            total_size_bytes: PARAKEET_TDT_11B_Q8.size,
            speed: 6.0,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 1600,
            featured: false,
            languages_label: "English".into(),
            quant: "Q8_0".into(),
            languages: lang_vec(&["en"]),
            sources: PARAKEET_TDT_11B_Q8.sources(),
            archive_url: None,
        },
        // ── Qwen3-ASR 1.7B GGUF Q4_K_M (1.7B lightweight tier) ──
        // Upstream WER 1.81%, substantially better than 0.6B Q8_0 (2.11%), only 448 MB larger.
        // 14-20% faster than Q5_K_M due to reduced memory bandwidth.
        ModelInfo {
            id: "qwen3-asr-1.7b-q4-gguf".into(),
            name: "Qwen3-ASR 1.7B".into(),
            description: "Lightweight version: ~15% faster, uses less memory".into(),
            model_type: "qwen3-asr-gguf".into(),
            total_size_bytes: QWEN3_17B_Q4.size,
            speed: 4.5,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 2300,
            featured: false,
            languages_label: "30 languages".into(),
            quant: "Q4_K_M".into(),
            languages: lang_vec(QWEN3_LANGUAGES),
            sources: QWEN3_17B_Q4.sources(),
            archive_url: None,
        },
        // ── Qwen3-ASR 1.7B GGUF Q5_K_M (maximum accuracy tier) ──
        // Upstream WER 1.65%. Upstream default tier for 1.7B. Decoding cost ~2x of 0.6B.
        ModelInfo {
            id: "qwen3-asr-1.7b-gguf".into(),
            name: "Qwen3-ASR 1.7B High Precision".into(),
            description: "Recommended version with maximum quality".into(),
            model_type: "qwen3-asr-gguf".into(),
            total_size_bytes: QWEN3_17B_Q5.size,
            speed: 4.0,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 2600,
            featured: true,
            languages_label: "30 languages".into(),
            quant: "Q5_K_M".into(),
            languages: lang_vec(QWEN3_LANGUAGES),
            sources: QWEN3_17B_Q5.sources(),
            archive_url: None,
        },
        // Whisper Large v3 Turbo Q4_K_M GGUF (multilingual, transcribe.cpp).
        // Fast, high-accuracy multilingual recognition across 100 languages.
        ModelInfo {
            id: "whisper-large-v3-turbo-gguf".into(),
            name: "Whisper Large v3 Turbo".into(),
            description: "Great balance of high accuracy and speed for multilingual speech".into(),
            model_type: "whisper-gguf".into(),
            total_size_bytes: WHISPER_LARGE_V3_TURBO_Q4.size,
            speed: 3.5,
            accuracy: 8.5,
            recommended: false,
            memory_mb: 1800,
            featured: false,
            languages_label: "100 languages".into(),
            quant: "Q4_K_M".into(),
            languages: lang_vec(WHISPER_LANGUAGES),
            sources: WHISPER_LARGE_V3_TURBO_Q4.sources(),
            archive_url: None,
        },
        // Whisper Large v3 GGUF: broad multilingual coverage at high accuracy.
        ModelInfo {
            id: "whisper-large-v3-gguf".into(),
            name: "Whisper Large v3".into(),
            description: "High-accuracy transcription across 100 languages".into(),
            model_type: "whisper-gguf".into(),
            total_size_bytes: WHISPER_LARGE_V3_Q4.size,
            speed: 3.0,
            accuracy: 8.8,
            recommended: false,
            memory_mb: 2000,
            featured: false,
            languages_label: "100 languages".into(),
            quant: "Q4_K_M".into(),
            languages: lang_vec(WHISPER_LANGUAGES),
            sources: WHISPER_LARGE_V3_Q4.sources(),
            archive_url: None,
        },
        // Whisper Large v2 Q4_K_M GGUF (multilingual, transcribe.cpp).
        // The high-accuracy Whisper tier for 100 languages, at the cost of speed.
        ModelInfo {
            id: "whisper-large-v2-gguf".into(),
            name: "Whisper Large v2".into(),
            description: "High-precision transcription when accuracy is the top priority".into(),
            model_type: "whisper-gguf".into(),
            total_size_bytes: WHISPER_LARGE_V2_Q4.size,
            speed: 2.5,
            accuracy: 9.0,
            recommended: false,
            memory_mb: 2800,
            featured: false,
            languages_label: "100 languages".into(),
            quant: "Q4_K_M".into(),
            languages: lang_vec(WHISPER_LANGUAGES),
            sources: WHISPER_LARGE_V2_Q4.sources(),
            archive_url: None,
        },
    ]
}

// GGUF weight coordinates (repository, file name, byte size, and SHA-256).
// Most weights are byte-for-byte mirrors of handy-computer's transcribe.cpp-compatible
// conversions in `cswk/sayit-asr-gguf`. GigaAM and Whisper still use the upstream
// repositories until identical files are copied to the project mirror.
//
// Do not replace these files with similarly named GGUF conversions from other repositories.
// They may target llama.cpp-derived runtimes and use a different `general.architecture` tag,
// which transcribe.cpp rejects with "unsupported architecture (status 5)" even when the
// download and checksum succeed. A source change must preserve the exact bytes. The downloader
// checks `size_bytes` before accepting the transfer and verifies SHA-256 before installation.

const PARAKEET_UNIFIED_EN_Q4: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "parakeet-unified-en-0.6b-Q4_K_M.gguf",
    size: 477_274_496,
    sha256: "a8bf3de2b393bd14ead5a858c3748d5e3b07a20fdeabdd3b498fba4f463fa929",
};

const PARAKEET_TDT_V3_Q8: GgufWeight = GgufWeight {
    repo: "handy-computer/parakeet-tdt-0.6b-v3-gguf",
    file: "parakeet-tdt-0.6b-v3-Q8_0.gguf",
    size: 739_508_576,
    sha256: "5859f77944efcd8eafa23a6350731960b2b55b2203df51f319665c807d802cc7",
};

const FUNASR_MLT_NANO_Q8: GgufWeight = GgufWeight {
    repo: "handy-computer/Fun-ASR-MLT-Nano-2512-gguf",
    file: "Fun-ASR-MLT-Nano-2512-Q8_0.gguf",
    size: 891_271_232,
    sha256: "d12476d8d9f2baa0ebf738fa955fa05ed33a654f1567289033a810c45d9d9002",
};

const PARAKEET_TDT_11B_Q8: GgufWeight = GgufWeight {
    repo: "handy-computer/parakeet-tdt-1.1b-gguf",
    file: "parakeet-tdt-1.1b-Q8_0.gguf",
    size: 1_267_288_736,
    sha256: "8479e1ed0b7244e293ed81f547c69074a38c00e17511d8ecae2d273bc7b2ceda",
};

const GIGAAM_V3_E2E_CTC_Q8: GgufWeight = GgufWeight {
    repo: "handy-computer/gigaam-v3-e2e-ctc-gguf",
    file: "gigaam-v3-e2e-ctc-Q8_0.gguf",
    size: 272_151_136,
    sha256: "9ccce4750dc813a493d96ca15ee251712bedec15ac9a02fa3d2bd732f08ae5eb",
};

const WHISPER_LARGE_V3_Q4: GgufWeight = GgufWeight {
    repo: "handy-computer/whisper-large-v3-gguf",
    file: "whisper-large-v3-Q4_K_M.gguf",
    size: 997_303_008,
    sha256: "6fe933811cec4cd3159debc46520ecd3aac6c7e322ece2ac61fcfdab184e1fe0",
};

const NEMOTRON_STREAMING_Q4: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "nemotron-3.5-asr-streaming-0.6b-Q4_K_M.gguf",
    size: 495_831_520,
    sha256: "41c99fa5fb6f3d35f68e79adc3e755eca2232a8d921178bd647b71194792b8fd",
};

const GIGAAM_V3_E2E_RNNT_Q8: GgufWeight = GgufWeight {
    repo: "handy-computer/gigaam-v3-e2e-rnnt-gguf",
    file: "gigaam-v3-e2e-rnnt-Q8_0.gguf",
    size: 273_724_832,
    sha256: "78d63b47723b7f8d78c6113a6ef983b5a86e2a86f6c273e1f5cb6967b1c4467a",
};

const WHISPER_SMALL_Q4: GgufWeight = GgufWeight {
    repo: "handy-computer/whisper-small-gguf",
    file: "whisper-small-Q4_K_M.gguf",
    size: 171_630_656,
    sha256: "b204d2005a3e5d4fe6153bd61e5e8b32e757ff7b017ac8f61c6f051c2f80e939",
};

const WHISPER_LARGE_V3_TURBO_Q4: GgufWeight = GgufWeight {
    repo: "handy-computer/whisper-large-v3-turbo-gguf",
    file: "whisper-large-v3-turbo-Q4_K_M.gguf",
    size: 536_069_728,
    sha256: "ecfe9b6beb4ab18fef49187cc968cc74b5168b94629c8830e2ca6b794c6e25ed",
};

const WHISPER_LARGE_V2_Q4: GgufWeight = GgufWeight {
    repo: "handy-computer/whisper-large-v2-gguf",
    file: "whisper-large-v2-Q4_K_M.gguf",
    size: 996_526_080,
    sha256: "76aa37b205abc1fb7a9e7aaf0655b8747995b81e6bb72c18f4b1acf59e222f79",
};

const SENSEVOICE: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "SenseVoiceSmall-Q8_0.gguf",
    size: 252_684_608,
    sha256: "6c759ee4c9748c9b3f7a5a60ca74f0f7e685fb9d45d1378fce7cfd62f59adf29",
};

const FUNASR_NANO_Q8: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Fun-ASR-Nano-2512-Q8_0.gguf",
    size: 891_270_912,
    sha256: "681caef6df15a2c0e153b40ca7fe4087fdf65751fa5e6fe605d8a75dff969e61",
};

const QWEN3_06B_Q8: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Qwen3-ASR-0.6B-Q8_0.gguf",
    size: 850_423_456,
    sha256: "f081b2d5e23bd669d92cc331d722a8a0681943b8e6f34b48996fd5c319b5acd8",
};

const QWEN3_17B_Q4: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Qwen3-ASR-1.7B-Q4_K_M.gguf",
    size: 1_319_830_496,
    sha256: "b7afe3674f653fa84f712ed2440353c6e7cf7f93697fef76b05a26538b24844e",
};

const QWEN3_17B_Q5: GgufWeight = GgufWeight {
    repo: "cswk/sayit-asr-gguf",
    file: "Qwen3-ASR-1.7B-Q5_K_M.gguf",
    size: 1_517_290_464,
    sha256: "034c557fe92ff8fcd9a9c041cbdaad347be0a86a58d3a348f63cf3f0180879d0",
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Catalog internal consistency invariants. Fast, offline test to catch coordinate/structural mistakes.
    #[test]
    fn catalog_entries_are_internally_consistent() {
        let models = get_available_models();
        assert!(!models.is_empty());

        let mut ids = std::collections::HashSet::new();
        let mut names = std::collections::HashSet::new();
        for m in &models {
            assert!(ids.insert(m.id.clone()), "Duplicate model id: {}", m.id);
            // Display names must remain distinct (e.g. Qwen3 1.7B variants distinguished by High Precision).
            assert!(names.insert(m.name.clone()), "Duplicate display name: {}", m.name);
            // Model ID determines local directory name; must end with -gguf.
            assert!(m.id.ends_with("-gguf"), "{} id should end with -gguf", m.id);
            assert!(!m.sources.is_empty(), "{} has no download sources", m.id);

            // Parameter triplet: omitting any causes gaps in the UI parameter row.
            assert!(m.memory_mb > 0, "{} missing memory_mb", m.id);
            assert!(!m.languages_label.is_empty(), "{} missing languages_label", m.id);
            assert!(!m.quant.is_empty(), "{} missing quant", m.id);

            // Display names must not contain quantization suffixes (those belong in `quant`).
            assert!(
                !m.name.contains("GGUF")
                    && !m.name.contains("Q8")
                    && !m.name.contains("Q4")
                    && !m.name.contains("Q5"),
                "{} display name contains quantization terms: {}",
                m.id,
                m.name
            );

            for s in &m.sources {
                let sum: u64 = s.files.iter().map(|f| f.size_bytes).sum();
                assert_eq!(
                    sum, m.total_size_bytes,
                    "{} source {} size sum {} differs from total_size_bytes {}",
                    m.id, s.source, sum, m.total_size_bytes
                );
                for f in &s.files {
                    assert!(
                        f.url.ends_with(&f.name),
                        "{} URL does not match file name: {}",
                        m.id,
                        f.url
                    );
                    let sha = f.sha256.as_deref().unwrap_or("");
                    assert_eq!(sha.len(), 64, "{} file {} missing or invalid sha256", m.id, f.name);
                }
            }
        }

        // Exactly one recommended model: used as default highlight in UI.
        assert_eq!(
            models.iter().filter(|m| m.recommended).count(),
            1,
            "Exactly one model must be marked recommended"
        );

        // At least three featured models; recommended model must be featured.
        assert!(
            models.iter().filter(|m| m.featured).count() >= 3,
            "Featured models must be at least three"
        );
        assert!(
            models.iter().any(|m| m.recommended && m.featured),
            "Recommended model must be featured"
        );
    }

    /// Frontend source selector uses models[0].sources. All models must provide the same sources.
    #[test]
    fn every_model_offers_the_same_download_sources() {
        let models = get_available_models();
        let expected: Vec<&str> = models[0]
            .sources
            .iter()
            .map(|s| s.source.as_str())
            .collect();
        for m in &models {
            let got: Vec<&str> = m.sources.iter().map(|s| s.source.as_str()).collect();
            assert_eq!(got, expected, "{} download sources differ from first model", m.id);
        }
        assert!(expected.contains(&"HuggingFace Mirror"));
    }

    #[test]
    fn whisper_catalog_entries_cover_selected_tiers() {
        let models = get_available_models();
        let expected = [
            (
                "whisper-small-gguf",
                171_630_656,
                "b204d2005a3e5d4fe6153bd61e5e8b32e757ff7b017ac8f61c6f051c2f80e939",
            ),
            (
                "whisper-large-v3-turbo-gguf",
                536_069_728,
                "ecfe9b6beb4ab18fef49187cc968cc74b5168b94629c8830e2ca6b794c6e25ed",
            ),
            (
                "whisper-large-v3-gguf",
                997_303_008,
                "6fe933811cec4cd3159debc46520ecd3aac6c7e322ece2ac61fcfdab184e1fe0",
            ),
            (
                "whisper-large-v2-gguf",
                996_526_080,
                "76aa37b205abc1fb7a9e7aaf0655b8747995b81e6bb72c18f4b1acf59e222f79",
            ),
        ];

        for (id, size, sha256) in expected {
            let model = models
                .iter()
                .find(|model| model.id == id)
                .unwrap_or_else(|| panic!("{id} must be present in the catalog"));
            let file = &model.sources[0].files[0];

            assert_eq!(model.model_type, "whisper-gguf");
            assert!(model.languages.iter().any(|language| language == "uk"));
            assert_eq!(model.quant, "Q4_K_M");
            assert!(!model.featured);
            assert_eq!(model.total_size_bytes, size);
            assert_eq!(file.size_bytes, size);
            assert_eq!(file.sha256.as_deref(), Some(sha256));
        }
    }

    /// The catalog language lists must match the real support matrix verified
    /// against upstream model cards, or per-model compatibility badges lie.
    #[test]
    fn catalog_language_matrix_matches_upstream() {
        let models = get_available_models();
        let languages = |id: &str| {
            models
                .iter()
                .find(|m| m.id == id)
                .unwrap_or_else(|| panic!("{id} must be present in the catalog"))
                .languages
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
        };

        // Keep these fixtures independent from production constants so the test
        // still catches an incorrect support matrix in the catalog.
        let whisper_100: &[&str] = &[
            "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar",
            "sv", "it", "id", "hi", "fi", "vi", "he", "uk", "el", "ms", "cs", "ro", "da", "hu",
            "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk", "te", "fa",
            "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn",
            "bs", "kk", "sq", "sw", "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc",
            "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo", "ht", "ps", "tk", "nn",
            "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw",
            "su", "yue",
        ];
        let qwen3_30: &[&str] = &[
            "zh", "en", "yue", "ar", "de", "fr", "es", "pt", "id", "it", "ko", "ru", "th", "vi",
            "ja", "tr", "hi", "ms", "nl", "sv", "da", "fi", "pl", "cs", "fil", "fa", "el", "hu",
            "mk", "ro",
        ];
        let nemotron_36: &[&str] = &[
            "en", "es", "fr", "it", "pt", "nl", "de", "tr", "ru", "ar", "hi", "ja", "ko", "vi",
            "uk", "pl", "sv", "cs", "nb", "da", "bg", "fi", "hr", "sk", "zh", "hu", "ro", "et",
            "el", "lt", "lv", "mt", "sl", "he", "th", "nn",
        ];
        let parakeet_v3_25: &[&str] = &[
            "bg", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "de", "el", "hu", "it", "lv",
            "lt", "mt", "pl", "pt", "ro", "ru", "sk", "sl", "es", "sv", "uk",
        ];
        let funasr_mlt_31: &[&str] = &[
            "zh", "en", "yue", "ja", "ko", "vi", "id", "th", "ms", "tl", "ar", "hi", "bg", "hr",
            "cs", "da", "nl", "et", "fi", "el", "hu", "ga", "lv", "lt", "mt", "pl", "pt", "ro",
            "sk", "sl", "sv",
        ];

        assert_eq!(whisper_100.len(), 100, "canonical Whisper list must hold 100 codes");
        assert_eq!(qwen3_30.len(), 30);
        assert_eq!(nemotron_36.len(), 36);
        assert_eq!(parakeet_v3_25.len(), 25);
        assert_eq!(funasr_mlt_31.len(), 31);

        let expected: Vec<(&str, &[&str])> = vec![
            ("parakeet-unified-en-0.6b-gguf", &["en"]),
            ("sensevoice-small-gguf", &["zh", "en", "ja", "ko", "yue"]),
            ("parakeet-tdt-0.6b-v3-gguf", parakeet_v3_25),
            ("nemotron-asr-streaming-0.6b-gguf", nemotron_36),
            ("gigaam-v3-e2e-rnnt-gguf", &["ru"]),
            ("gigaam-v3-e2e-ctc-gguf", &["ru"]),
            ("funasr-nano-2512-gguf", &["zh", "en", "ja"]),
            ("funasr-mlt-nano-2512-gguf", funasr_mlt_31),
            ("qwen3-asr-0.6b-gguf", qwen3_30),
            ("qwen3-asr-1.7b-q4-gguf", qwen3_30),
            ("qwen3-asr-1.7b-gguf", qwen3_30),
            ("whisper-small-gguf", whisper_100),
            ("parakeet-tdt-1.1b-gguf", &["en"]),
            ("whisper-large-v3-turbo-gguf", whisper_100),
            ("whisper-large-v3-gguf", whisper_100),
            ("whisper-large-v2-gguf", whisper_100),
        ];

        for (id, wanted) in expected {
            let got = languages(id);
            assert_eq!(got, wanted, "{} language list differs from upstream expectation", id);
        }
    }

    /// Ordering contract: list order defines UI order, monotonically decreasing in speed.
    #[test]
    fn models_are_ordered_from_fast_to_slow() {
        let models = get_available_models();
        for w in models.windows(2) {
            assert!(
                w[0].speed >= w[1].speed,
                "{} speed ({}) should not be lower than subsequent {} speed ({})",
                w[0].id,
                w[0].speed,
                w[1].id,
                w[1].speed
            );
        }
    }
}

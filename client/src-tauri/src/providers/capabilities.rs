use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HotwordDelivery {
    Vocabulary,
    Context,
    Instruction,
    ProtocolHasNoSlot,
    NotWiredUp,
    UnknownProvider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AsrHotwordCapability {
    pub delivery: HotwordDelivery,
    pub client_cap: Option<usize>,
}

const CLOUD_CAPABILITIES: &[(&str, HotwordDelivery, Option<usize>)] = &[
    ("doubao", HotwordDelivery::Context, None),
    ("doubao_v2", HotwordDelivery::Context, None),
    ("qwen", HotwordDelivery::Context, None),
    ("aliyun", HotwordDelivery::Context, None),
    ("qwen_realtime", HotwordDelivery::Context, None),
    ("qwen_audio_stream", HotwordDelivery::Vocabulary, Some(100)),
    ("qwen_omni", HotwordDelivery::Instruction, None),
    ("mimo", HotwordDelivery::NotWiredUp, None),
    ("groq_whisper", HotwordDelivery::NotWiredUp, None),
    ("openai_transcribe", HotwordDelivery::NotWiredUp, None),
    ("gemini_transcribe", HotwordDelivery::Instruction, Some(100)),
    (
        "openrouter_transcribe",
        HotwordDelivery::ProtocolHasNoSlot,
        None,
    ),
    ("openai_compat", HotwordDelivery::Instruction, None),
    ("deepgram", HotwordDelivery::Vocabulary, None),
];

const UI_CAPABILITIES: &[(&str, HotwordDelivery, Option<usize>)] = &[
    ("server", HotwordDelivery::Context, None),
    ("local", HotwordDelivery::NotWiredUp, None),
];

pub(crate) fn is_cloud_asr_provider(provider: &str) -> bool {
    CLOUD_CAPABILITIES
        .iter()
        .any(|(key, _, _)| *key == provider)
}

pub fn hotword_capability(provider: &str) -> AsrHotwordCapability {
    CLOUD_CAPABILITIES
        .iter()
        .chain(UI_CAPABILITIES.iter())
        .find(|(key, _, _)| *key == provider)
        .map(|(_, delivery, client_cap)| AsrHotwordCapability {
            delivery: *delivery,
            client_cap: *client_cap,
        })
        .unwrap_or(AsrHotwordCapability {
            delivery: HotwordDelivery::UnknownProvider,
            client_cap: None,
        })
}

#[tauri::command]
pub fn asr_hotword_capability_matrix() -> HashMap<String, AsrHotwordCapability> {
    CLOUD_CAPABILITIES
        .iter()
        .chain(UI_CAPABILITIES.iter())
        .map(|(provider, _, _)| ((*provider).to_string(), hotword_capability(provider)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn registry_dispatch_keys() -> BTreeSet<String> {
        let source = include_str!("registry.rs");
        parse_dispatch_keys(source)
    }

    #[test]
    fn dispatch_source_parser_ignores_comment_only_provider_arms() {
        let source = r#"
pub async fn cloud_transcribe() {
    match provider {
        "real" => Ok(()),
        // "ghost" => Err(()),
        /* "inline_ghost" => Err(()), */
        /*
            "multiline_ghost" => Err(()),
        */
        other => Err(()),
    }
}
pub async fn test_asr_connection() {}
"#;
        let expected = ["real".to_string()].into();

        assert_eq!(parse_dispatch_keys(source), expected);
    }

    fn parse_dispatch_keys(source: &str) -> BTreeSet<String> {
        let dispatch_start = source
            .find("pub async fn cloud_transcribe(")
            .expect("cloud_transcribe must exist in registry.rs");
        let after_dispatch = &source[dispatch_start..];
        let dispatch_end = after_dispatch
            .find("pub async fn test_asr_connection(")
            .expect("test_asr_connection must follow cloud_transcribe");
        let dispatch = &after_dispatch[..dispatch_end];
        let mut block_comment_depth = 0;

        dispatch
            .lines()
            .filter_map(|line| {
                if block_comment_depth == 0 && line.trim_start().starts_with("//") {
                    return None;
                }

                let mut uncommented = String::with_capacity(line.len());
                let mut characters = line.chars().peekable();
                while let Some(character) = characters.next() {
                    if character == '/' && characters.peek() == Some(&'*') {
                        characters.next();
                        block_comment_depth += 1;
                    } else if character == '*'
                        && characters.peek() == Some(&'/')
                        && block_comment_depth > 0
                    {
                        characters.next();
                        block_comment_depth -= 1;
                    } else if block_comment_depth == 0 {
                        uncommented.push(character);
                    }
                }
                Some(uncommented)
            })
            .filter_map(|line| {
                line.split_once("=>")
                    .map(|(pattern, _)| pattern.to_string())
            })
            .flat_map(|pattern| {
                pattern
                    .split('"')
                    .enumerate()
                    .filter(|(index, _)| index % 2 == 1)
                    .map(|(_, key)| key.to_string())
                    .collect::<Vec<_>>()
            })
            .collect()
    }

    #[test]
    fn declared_cloud_keys_match_the_registry_dispatch_source() {
        let dispatch_keys = registry_dispatch_keys();
        assert!(!dispatch_keys.is_empty());

        let declared_cloud_keys: BTreeSet<String> = CLOUD_CAPABILITIES
            .iter()
            .map(|(provider, _, _)| (*provider).to_string())
            .collect();

        assert_eq!(declared_cloud_keys, dispatch_keys);
        let matrix = asr_hotword_capability_matrix();
        assert!(
            declared_cloud_keys
                .iter()
                .all(|provider| { matrix[provider].delivery != HotwordDelivery::UnknownProvider })
        );
    }

    #[test]
    fn cloud_asr_provider_validation_accepts_only_dispatch_keys() {
        assert!(is_cloud_asr_provider("qwen_omni"));
        assert!(!is_cloud_asr_provider("qwen_omni_35_plus"));
        assert!(!is_cloud_asr_provider("unknown_provider"));
    }

    #[test]
    fn the_matrix_covers_cloud_and_ui_only_entries() {
        let matrix = asr_hotword_capability_matrix();
        let dispatch_keys = registry_dispatch_keys();

        assert_eq!(matrix.len(), dispatch_keys.len() + 2);
        assert_eq!(matrix["server"].delivery, HotwordDelivery::Context);
        assert_eq!(matrix["local"].delivery, HotwordDelivery::NotWiredUp);
    }

    #[test]
    fn unknown_providers_remain_distinct_from_known_unsupported_providers() {
        let unknown = hotword_capability("unknown_provider");

        assert_eq!(unknown.delivery, HotwordDelivery::UnknownProvider);
        assert_eq!(
            hotword_capability("mimo").delivery,
            HotwordDelivery::NotWiredUp
        );
        assert_ne!(unknown.delivery, hotword_capability("mimo").delivery);
    }

    #[test]
    fn provider_delivery_matches_the_existing_send_path() {
        for provider in [
            "doubao",
            "doubao_v2",
            "qwen",
            "aliyun",
            "qwen_realtime",
            "server",
        ] {
            assert_eq!(
                hotword_capability(provider).delivery,
                HotwordDelivery::Context,
                "{provider}"
            );
        }
        assert_eq!(
            hotword_capability("qwen_audio_stream").delivery,
            HotwordDelivery::Vocabulary
        );
        for provider in ["qwen_omni", "gemini_transcribe", "openai_compat"] {
            assert_eq!(
                hotword_capability(provider).delivery,
                HotwordDelivery::Instruction,
                "{provider}"
            );
        }
        for provider in ["mimo", "groq_whisper", "openai_transcribe", "local"] {
            assert_eq!(
                hotword_capability(provider).delivery,
                HotwordDelivery::NotWiredUp,
                "{provider}"
            );
        }
        assert_eq!(
            hotword_capability("deepgram").delivery,
            HotwordDelivery::Vocabulary
        );
        assert_eq!(
            hotword_capability("openrouter_transcribe").delivery,
            HotwordDelivery::ProtocolHasNoSlot
        );
    }

    #[test]
    fn client_caps_match_the_provider_request_limits() {
        assert_eq!(
            hotword_capability("qwen_audio_stream").client_cap,
            Some(crate::providers::asr_qwen_audio_stream::hotword_limit_for_docs())
        );
        assert_eq!(
            hotword_capability("gemini_transcribe").client_cap,
            Some(crate::providers::asr_gemini::hotword_limit_for_docs())
        );
        assert_eq!(hotword_capability("deepgram").client_cap, None);

        let matrix = asr_hotword_capability_matrix();
        let capped_providers: BTreeSet<_> = matrix
            .iter()
            .filter(|(_, capability)| capability.client_cap.is_some())
            .map(|(provider, _)| provider.as_str())
            .collect();
        assert_eq!(
            capped_providers,
            ["gemini_transcribe", "qwen_audio_stream"].into()
        );
    }

    #[test]
    fn capabilities_serialize_for_the_frontend_contract() {
        let serialized = serde_json::to_value(hotword_capability("qwen_audio_stream")).unwrap();

        assert_eq!(serialized["delivery"], "vocabulary");
        assert_eq!(serialized["clientCap"], 100);
    }
}

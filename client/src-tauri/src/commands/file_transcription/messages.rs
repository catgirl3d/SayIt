use crate::error_protocol;

fn format_position_hms(milliseconds: u64) -> String {
    let total_seconds = milliseconds / 1000;
    let hours = total_seconds / 3600;
    let minutes = (total_seconds % 3600) / 60;
    let seconds = total_seconds % 60;
    format!("{hours}:{minutes:02}:{seconds:02}")
}

pub(super) fn file_model_label(model_id: &str) -> String {
    crate::models::catalog::get_available_models()
        .into_iter()
        .find(|model| model.id == model_id)
        .map(|model| format!("{} ({})", model.name, model.id))
        .unwrap_or_else(|| model_id.to_string())
}

pub(super) fn window_recognition_error(
    model: &str,
    language: &str,
    position_ms: u64,
    detail: &str,
) -> String {
    format!(
        "Recognition failed with model \"{model}\" in language \"{language}\" at {}: {detail}",
        format_position_hms(position_ms)
    )
}

/// Builds the final cloud-window failure message. An enveloped `sayit_error` code must stay at
/// the start of the message because the web UI classifies by code only there; the window
/// position context is wrapped around the detail text without pushing the code out.
pub(super) fn cloud_window_recognition_error(
    label: &str,
    position_ms: Option<u64>,
    detail: &str,
) -> String {
    let (code, detail) = match error_protocol::decode(detail) {
        Some((code, text)) => (Some(code), text),
        None => (None, detail),
    };
    let message = match position_ms {
        Some(position_ms) => format!(
            "Recognition failed with cloud ASR \"{label}\" at {}: {detail}",
            format_position_hms(position_ms)
        ),
        None => format!("Recognition failed with cloud ASR \"{label}\": {detail}"),
    };
    match code {
        Some(code) => error_protocol::encode(code, message),
        None => message,
    }
}

pub(super) fn model_load_error(model: &str, detail: &str) -> String {
    format!("Failed to load the local model \"{model}\": {detail}")
}

pub(super) fn all_windows_empty_error(model: &str, language: &str) -> String {
    format!(
        "The local model \"{model}\" returned no text for speech detected audio (language \"{language}\")"
    )
}

pub(super) fn all_cloud_windows_empty_error(label: &str, language: &str) -> String {
    format!(
        "The cloud ASR service \"{label}\" returned no text for detected speech (language \"{language}\")"
    )
}

pub(super) fn skipped_fragments_warning(
    count: u64,
    first_position_ms: Option<u64>,
) -> Option<String> {
    if count == 0 {
        return None;
    }
    let first_position_ms = first_position_ms.unwrap_or(0);
    if count == 1 {
        Some(format!(
            "1 fragment without recognized text was skipped (first at {})",
            format_position_hms(first_position_ms)
        ))
    } else {
        Some(format!(
            "{count} fragments without recognized text were skipped (first at {})",
            format_position_hms(first_position_ms)
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_error_position_formats_hours_minutes_and_seconds() {
        assert_eq!(format_position_hms(0), "0:00:00");
        assert_eq!(format_position_hms(59_000), "0:00:59");
        assert_eq!(format_position_hms(3_942_000), "1:05:42");
        assert_eq!(format_position_hms(86_401_000), "24:00:01");
    }

    #[test]
    fn window_recognition_error_contains_model_language_position_and_detail() {
        assert_eq!(
            window_recognition_error(
                "SenseVoice Small (sensevoice-small-gguf)",
                "uk",
                3_942_000,
                "Inference failed: native error"
            ),
            "Recognition failed with model \"SenseVoice Small (sensevoice-small-gguf)\" in language \"uk\" at 1:05:42: Inference failed: native error"
        );
    }

    #[test]
    fn cloud_window_recognition_error_contains_label_position_and_detail() {
        assert_eq!(
            cloud_window_recognition_error("Deepgram", Some(192_000), "Inference failed"),
            "Recognition failed with cloud ASR \"Deepgram\" at 0:03:12: Inference failed"
        );
    }

    #[test]
    fn cloud_window_recognition_error_omits_the_position_when_unknown() {
        assert_eq!(
            cloud_window_recognition_error("Deepgram", None, "Inference failed"),
            "Recognition failed with cloud ASR \"Deepgram\": Inference failed"
        );
    }

    #[test]
    fn cloud_window_recognition_error_keeps_the_sayit_error_code_at_the_prefix() {
        let message = cloud_window_recognition_error(
            "OpenRouter",
            Some(192_000),
            "sayit_error:provider_bad_key:HTTP 401: 密钥无效",
        );
        assert_eq!(
            message,
            "sayit_error:provider_bad_key:Recognition failed with cloud ASR \"OpenRouter\" at 0:03:12: HTTP 401: 密钥无效"
        );
        assert_eq!(
            error_protocol::decode(&message),
            Some((
                "provider_bad_key",
                "Recognition failed with cloud ASR \"OpenRouter\" at 0:03:12: HTTP 401: 密钥无效"
            ))
        );
    }

    #[test]
    fn cloud_window_recognition_error_keeps_the_code_without_a_position() {
        assert_eq!(
            cloud_window_recognition_error(
                "Deepgram",
                None,
                "sayit_error:provider_insufficient_balance:HTTP 402"
            ),
            "sayit_error:provider_insufficient_balance:Recognition failed with cloud ASR \"Deepgram\": HTTP 402"
        );
    }

    #[test]
    fn cloud_window_recognition_error_leaves_a_malformed_envelope_untouched() {
        assert_eq!(
            cloud_window_recognition_error("Deepgram", Some(0), "sayit_error:missing-separator"),
            "Recognition failed with cloud ASR \"Deepgram\" at 0:00:00: sayit_error:missing-separator"
        );
    }

    #[test]
    fn cloud_window_recognition_error_does_not_unwrap_a_nested_envelope() {
        assert_eq!(
            cloud_window_recognition_error(
                "Deepgram",
                None,
                "sayit_error:outer:sayit_error:inner:payload"
            ),
            "sayit_error:outer:Recognition failed with cloud ASR \"Deepgram\": sayit_error:inner:payload"
        );
    }

    #[test]
    fn model_load_error_contains_the_selected_model_and_detail() {
        assert_eq!(
            model_load_error(
                "SenseVoice Small (sensevoice-small-gguf)",
                "engine unavailable"
            ),
            "Failed to load the local model \"SenseVoice Small (sensevoice-small-gguf)\": engine unavailable"
        );
    }

    #[test]
    fn all_empty_windows_keep_a_model_and_language_failure_context() {
        assert_eq!(
            all_windows_empty_error("GigaAM v3 (gigaam-v3-e2e-rnnt-gguf)", "ru"),
            "The local model \"GigaAM v3 (gigaam-v3-e2e-rnnt-gguf)\" returned no text for speech detected audio (language \"ru\")"
        );
    }

    #[test]
    fn file_errors_use_catalog_display_name_and_fallback_to_unknown_id() {
        assert_eq!(
            file_model_label("sensevoice-small-gguf"),
            "SenseVoice Small (sensevoice-small-gguf)"
        );
        assert_eq!(file_model_label("custom-model"), "custom-model");
    }

    #[test]
    fn skipped_fragments_warning_handles_zero_one_and_multiple_fragments() {
        assert_eq!(skipped_fragments_warning(0, None), None);
        assert_eq!(
            skipped_fragments_warning(1, Some(140_000)),
            Some("1 fragment without recognized text was skipped (first at 0:02:20)".into())
        );
        assert_eq!(
            skipped_fragments_warning(2, Some(140_000)),
            Some("2 fragments without recognized text were skipped (first at 0:02:20)".into())
        );
    }
}

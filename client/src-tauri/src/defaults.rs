//! Default values shared by the push-to-talk and hands-free shortcuts, WebDAV backup settings,
//! the local ASR startup fallbacks, and the audio/log retention cleanup.
//!
//! `src/services/defaults.ts` is the frontend source of truth, and `defaults.rs` is its
//! verified Rust mirror: the tests at the bottom of this file check these constants against
//! `defaults.ts`. The storage seed in `storage/mod.rs` is checked separately: its keys are
//! reconciled with `defaults.ts`, and the seeded shortcut constants have explicit assertions.

/// Push-to-talk key. It is also the fallback when the saved setting is missing or unusable.
///
/// It must not be Shift. Holding the right Shift key for about 8 seconds triggers the Windows
/// FilterKeys accessibility feature. After that the app never receives the key release, so
/// recording does not stop when the key is let go. This default used to be `ShiftRight`, which
/// bound every fresh install to that key out of the box; the frontend shipped the same default
/// (see `src/services/defaults.ts`). Right Ctrl sits nearby, has no accessibility trap, and does
/// not collide with the hands-free default (right Alt). The frontend also rejects the Shift keys
/// for this binding; see `PTT_FORBIDDEN_CODES` in `src/lib/shortcutKeys.ts`.
pub const SHORTCUT_PTT: &str = "ControlRight";

/// Hands-free key. It also accepts combos such as `Control+Shift+S`.
pub const SHORTCUT_HANDS_FREE: &str = "AltRight";

/// AI-cleanup toggle shortcut. Empty means nothing is registered, so an upgrade never grabs a
/// global combo the user already owns.
pub const SHORTCUT_TOGGLE_AI: &str = "";

/// Whether WebDAV backups include the transcription history. Off by default.
///
/// A backup always contains the configuration; history and recordings are optional. Both
/// default to off because a recording library can be several GB, and cloud drives (the free
/// Nutstore tier in particular) have monthly traffic quotas. Enabling either by default would
/// make an expensive decision on the user's behalf.
pub const WEBDAV_INCLUDE_HISTORY: bool = false;

/// Whether WebDAV backups include recording files. Off by default; see
/// `WEBDAV_INCLUDE_HISTORY` for the traffic-quota rationale.
///
/// This fallback is also what keeps an unset setting from silently uploading the whole audio
/// library while the UI checkbox stays unchecked.
pub const WEBDAV_INCLUDE_AUDIO: bool = false;

/// Number of backup copies kept on the server. Also the fallback when `webdav.keepCount` is
/// unset or below 1.
pub const WEBDAV_KEEP_COUNT: u64 = 5;

/// Default local ASR model used by the startup warm-up, mirroring `localAsr.modelId` in
/// `src/services/defaults.ts`.
pub const LOCAL_ASR_MODEL_ID: &str = "nemotron-asr-streaming-0.6b-gguf";

/// Default compute backend for the local ASR model, mirroring `localAsr.accelerator` in
/// `src/services/defaults.ts`. `auto` uses the GPU when one is available, otherwise the CPU.
pub const LOCAL_ASR_ACCELERATOR: &str = "auto";

/// Default idle timeout before the local model is unloaded, in minutes, mirroring
/// `localAsr.unloadIdleMinutes` in `src/services/defaults.ts`. 0 keeps the model resident.
pub const LOCAL_ASR_UNLOAD_IDLE_MINUTES: u64 = 0;

/// Default recording retention in days, mirroring `audioRetentionDays` in
/// `src/services/defaults.ts`.
pub const AUDIO_RETENTION_DAYS: i64 = -1; // -1 = keep forever

/// Default log retention in days, mirroring `logRetentionDays` in `src/services/defaults.ts`.
pub const LOG_RETENTION_DAYS: i64 = 30;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::DEFAULT_SETTINGS;
    use serde_json::{Value, json};

    const TS_DEFAULTS: &str = include_str!("../../src/services/defaults.ts");

    /// Returns the single `defaults.ts` line that defines `key`, or `None` when the key has no
    /// line. Two or more matching lines panic, because taking the first match would silently
    /// hide a duplicated entry.
    fn ts_default_line(key: &str) -> Option<&'static str> {
        let quoted_prefix = format!("'{key}':");
        let bare_prefix = format!("{key}:");
        let matches: Vec<&'static str> = TS_DEFAULTS
            .lines()
            .map(str::trim)
            .filter(|line| {
                line.starts_with(quoted_prefix.as_str()) || line.starts_with(bare_prefix.as_str())
            })
            .collect();
        match matches.as_slice() {
            [] => None,
            [line] => Some(*line),
            _ => panic!(
                "defaults.ts defines `{key}` on {} lines; expected exactly one",
                matches.len()
            ),
        }
    }

    /// Parses the value of one `defaults.ts` entry with a strict grammar: a single-quoted string
    /// without escapes, `true`, `false`, or an integer. A negative integer requires a leading
    /// `-` directly followed by ASCII digits; `- 1`, `-`, and `-1.5` are invalid. A negative
    /// literal is parsed as `i64` together with its minus sign, never as a magnitude followed by
    /// negation (that would break `i64::MIN`). Non-negative literals stay `u64`, so the full
    /// unsigned range up to `u64::MAX` is preserved. The value may be followed by an optional
    /// `,` and an optional `// comment`. Any other text panics with the key and the raw line.
    /// The comment is not split off by searching for `//`, so a `//` inside a quoted string is
    /// read as part of the string.
    fn parse_ts_value(key: &str, line: &str) -> Value {
        let body = match line
            .strip_prefix(format!("'{key}':").as_str())
            .or_else(|| line.strip_prefix(format!("{key}:").as_str()))
        {
            Some(body) => body.trim_start(),
            None => panic!("defaults.ts line does not start with the key `{key}`: {line}"),
        };

        let (value, rest) = if let Some(quoted) = body.strip_prefix('\'') {
            let end = quoted
                .find('\'')
                .unwrap_or_else(|| panic!("defaults.ts string for `{key}` is not closed: {line}"));
            let text = &quoted[..end];
            if text.contains('\\') {
                panic!(
                    "defaults.ts string for `{key}` contains an escape, which is not supported: {line}"
                );
            }
            (Value::String(text.to_owned()), &quoted[end + 1..])
        } else if let Some(rest) = body.strip_prefix("true") {
            (Value::Bool(true), rest)
        } else if let Some(rest) = body.strip_prefix("false") {
            (Value::Bool(false), rest)
        } else if let Some(digits_body) = body.strip_prefix('-') {
            let digits = digits_body.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                panic!("defaults.ts value for `{key}` is not a supported literal: {line}");
            }
            let number: i64 = body[..digits + 1].parse().unwrap_or_else(|error| {
                panic!("defaults.ts value for `{key}` is not an integer ({error}): {line}")
            });
            (json!(number), &body[digits + 1..])
        } else {
            let digits = body.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                panic!("defaults.ts value for `{key}` is not a supported literal: {line}");
            }
            let number: u64 = body[..digits].parse().unwrap_or_else(|error| {
                panic!("defaults.ts value for `{key}` is not an integer ({error}): {line}")
            });
            (json!(number), &body[digits..])
        };

        let rest = rest.trim_start();
        let rest = rest.strip_prefix(',').map_or(rest, str::trim_start);
        assert!(
            rest.is_empty() || rest.starts_with("//"),
            "defaults.ts value for `{key}` is followed by text other than `,` or a `//` comment: {line}"
        );
        value
    }

    /// The default for `key` as written in `defaults.ts`. Panics when the key has no line.
    fn ts_default(key: &str) -> Value {
        ts_default_if_present(key)
            .unwrap_or_else(|| panic!("defaults.ts has no line for the key `{key}`"))
    }

    /// Like `ts_default`, but returns `None` when `defaults.ts` has no line for the key.
    fn ts_default_if_present(key: &str) -> Option<Value> {
        ts_default_line(key).map(|line| parse_ts_value(key, line))
    }

    /// The JSON value stored in the storage seed for `key`.
    fn seed_value(key: &str) -> Value {
        let (_, literal) = DEFAULT_SETTINGS
            .iter()
            .find(|(seed_key, _)| *seed_key == key)
            .unwrap_or_else(|| panic!("storage seed has no entry for `{key}`"));
        serde_json::from_str(literal)
            .unwrap_or_else(|error| panic!("storage seed for `{key}` is not valid JSON: {error}"))
    }

    #[test]
    fn rust_defaults_match_frontend_defaults() {
        assert_eq!(json!(SHORTCUT_PTT), ts_default("shortcutPTT"));
        assert_eq!(json!(SHORTCUT_HANDS_FREE), ts_default("shortcutHandsFree"));
        assert_eq!(json!(SHORTCUT_TOGGLE_AI), ts_default("shortcutToggleAi"));
        assert_eq!(
            json!(WEBDAV_INCLUDE_HISTORY),
            ts_default("webdav.includeHistory")
        );
        assert_eq!(
            json!(WEBDAV_INCLUDE_AUDIO),
            ts_default("webdav.includeAudio")
        );
        assert_eq!(json!(WEBDAV_KEEP_COUNT), ts_default("webdav.keepCount"));
        assert_eq!(json!(LOCAL_ASR_MODEL_ID), ts_default("localAsr.modelId"));
        assert_eq!(
            json!(LOCAL_ASR_ACCELERATOR),
            ts_default("localAsr.accelerator")
        );
        assert_eq!(
            json!(LOCAL_ASR_UNLOAD_IDLE_MINUTES),
            ts_default("localAsr.unloadIdleMinutes")
        );
        assert_eq!(
            json!(AUDIO_RETENTION_DAYS),
            ts_default("audioRetentionDays")
        );
        assert_eq!(json!(LOG_RETENTION_DAYS), ts_default("logRetentionDays"));
        assert!(!SHORTCUT_PTT.contains("Shift"));
    }

    #[test]
    fn parses_negative_integer_with_trailing_comment() {
        assert_eq!(
            parse_ts_value("audioRetentionDays", "audioRetentionDays: -1, // forever"),
            json!(-1)
        );
    }

    #[test]
    fn parses_u64_max_without_narrowing_to_i64() {
        let line = format!("bigNumber: {},", u64::MAX);
        let value = parse_ts_value("bigNumber", &line);
        assert!(value.is_u64(), "u64::MAX must stay an unsigned value");
        assert!(!value.is_i64(), "u64::MAX must not be narrowed to i64");
        assert_eq!(value, json!(u64::MAX));
    }

    #[test]
    fn parses_i64_min_without_overflow() {
        let line = format!("bigNegative: {},", i64::MIN);
        assert_eq!(parse_ts_value("bigNegative", &line), json!(i64::MIN));
    }

    #[test]
    #[should_panic(expected = "not a supported literal")]
    fn rejects_minus_without_digits() {
        parse_ts_value("audioRetentionDays", "audioRetentionDays: -");
    }

    #[test]
    #[should_panic(expected = "not a supported literal")]
    fn rejects_minus_separated_from_digits() {
        parse_ts_value("audioRetentionDays", "audioRetentionDays: - 1");
    }

    #[test]
    #[should_panic(expected = "not a supported literal")]
    fn rejects_double_minus() {
        parse_ts_value("audioRetentionDays", "audioRetentionDays: --1");
    }

    #[test]
    #[should_panic(expected = "followed by text other than")]
    fn rejects_negative_fraction() {
        parse_ts_value("audioRetentionDays", "audioRetentionDays: -1.5");
    }

    #[test]
    fn storage_seed_matches_defaults() {
        assert_eq!(seed_value("shortcutPTT"), json!(SHORTCUT_PTT));
        assert_eq!(seed_value("shortcutHandsFree"), json!(SHORTCUT_HANDS_FREE));
        assert_eq!(seed_value("shortcutToggleAi"), json!(SHORTCUT_TOGGLE_AI));

        for &(key, literal) in DEFAULT_SETTINGS {
            // Seed keys that have no line in defaults.ts have nothing to compare against.
            let Some(expected) = ts_default_if_present(key) else {
                continue;
            };
            let seeded: Value = serde_json::from_str(literal).unwrap_or_else(|error| {
                panic!("storage seed for `{key}` is not valid JSON: {error}")
            });
            assert_eq!(
                seeded, expected,
                "storage seed for `{key}` differs from src/services/defaults.ts"
            );
        }
    }
}

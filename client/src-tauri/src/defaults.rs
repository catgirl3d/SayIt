//! Default values shared by the push-to-talk and hands-free shortcuts and by WebDAV backup
//! settings.
//!
//! These constants mirror `src/services/defaults.ts`, the frontend copy of the same defaults.
//! Rust keeps exactly one copy here. The tests at the bottom of this file reconcile both
//! files, and the storage seed in `storage/mod.rs`, against these constants.

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
    /// without escapes, `true`, `false`, or an unsigned integer. The value may be followed by an
    /// optional `,` and an optional `// comment`. Any other text panics with the key and the raw
    /// line. The comment is not split off by searching for `//`, so a `//` inside a quoted string
    /// is read as part of the string.
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
        } else {
            let digits = body.bytes().take_while(u8::is_ascii_digit).count();
            if digits == 0 {
                panic!("defaults.ts value for `{key}` is not a supported literal: {line}");
            }
            let number: u64 = body[..digits].parse().unwrap_or_else(|error| {
                panic!("defaults.ts value for `{key}` is not an unsigned integer ({error}): {line}")
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
        assert!(!SHORTCUT_PTT.contains("Shift"));
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

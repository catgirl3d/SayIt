//! Stable error envelope shared by Rust commands and the web UI.
//!
//! Human-readable details are intentionally not the contract: providers may return them in
//! different languages, and our own diagnostics can be reworded. The frontend classifies by
//! `code` and only shows `detail` as secondary diagnostic text.

const PREFIX: &str = "sayit_error:";

pub fn encode(code: &str, detail: impl AsRef<str>) -> String {
    format!("{}{}:{}", PREFIX, code, detail.as_ref())
}

/// Splits `sayit_error:<code>:<detail>` back into its parts; `None` when the value is not an
/// envelope. This is the syntactic parse the web UI performs, not validation of a known code:
/// only a prefix at the start counts, the code ends at the first `:`, and the rest — including
/// further colons — is detail.
pub fn decode(message: &str) -> Option<(&str, &str)> {
    message.strip_prefix(PREFIX)?.split_once(':')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_colons_and_unicode_in_detail() {
        assert_eq!(
            encode("provider_bad_key", "HTTP 401: 密钥无效"),
            "sayit_error:provider_bad_key:HTTP 401: 密钥无效"
        );
    }

    #[test]
    fn decode_mirrors_the_encode_format() {
        assert_eq!(
            decode("sayit_error:provider_bad_key:HTTP 401: 密钥无效"),
            Some(("provider_bad_key", "HTTP 401: 密钥无效"))
        );
        assert_eq!(decode("sayit_error:code:"), Some(("code", "")));
        assert_eq!(decode("sayit_error::detail"), Some(("", "detail")));
        assert_eq!(decode("sayit_error:missing-separator"), None);
        assert_eq!(decode("prefix sayit_error:code:detail"), None);
    }
}

const EMPTY_FRAGMENT_RETRY_COUNT: u8 = 1;

pub(super) fn append_transcript(existing: &mut String, next: &str) {
    let next = next.trim();
    if next.is_empty() {
        return;
    }
    if !existing.is_empty() {
        existing.push_str("\n\n");
    }
    existing.push_str(next);
}

pub(super) fn should_retry_empty_fragment(attempt: u8) -> bool {
    attempt < EMPTY_FRAGMENT_RETRY_COUNT
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_fragment_is_retried_once_then_skipped() {
        assert!(should_retry_empty_fragment(0));
        assert!(!should_retry_empty_fragment(1));
    }
}

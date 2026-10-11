// Inline reasoning blocks emitted by thinking models (Qwen3, DeepSeek-R1 and similar):
// the shared rules for what must never reach live captions or settled results.

/// Opening tag of an inline reasoning block.
const THINK_OPEN_TAG: &str = "<think>";
/// Closing tag of an inline reasoning block.
const THINK_CLOSE_TAG: &str = "</think>";
/// Marker some prompt presets use to separate reasoning from the final answer.
const FINAL_ANSWER_MARKER: &str = "最终答案";

/// Compiled once and reused: the live stream runs it on every delta.
static THINK_RE: once_cell::sync::Lazy<regex::Regex> = once_cell::sync::Lazy::new(|| {
    let pattern = format!(
        r"(?is){}.*?{}",
        regex::escape(THINK_OPEN_TAG),
        regex::escape(THINK_CLOSE_TAG)
    );
    regex::Regex::new(&pattern).unwrap_or_else(|_| {
        // fallback: leave the text untouched
        regex::Regex::new(r"^$").unwrap()
    })
});

/// Removes reasoning blocks emitted by models such as Qwen3: complete `<think>...</think>` pairs
/// are dropped, and an opening tag without a closing one hides everything from that tag on. An
/// unclosed block is the normal state of a live stream while the model is still thinking, and the
/// state of a generation cut off mid-reasoning, so both the live deltas and the settled result must
/// hide it. When the text carries a "final answer" marker, only what follows the marker is the
/// answer.
pub(super) fn strip_thinking(text: &str) -> String {
    let replaced = THINK_RE.replace_all(text, "");
    let truncated = match incomplete_reasoning_start(&replaced) {
        Some(start) => &replaced[..start],
        None => &replaced[..],
    };
    let cleaned = truncated.trim();

    if let Some(pos) = cleaned.find(FINAL_ANSWER_MARKER) {
        let after = &cleaned[pos + FINAL_ANSWER_MARKER.len()..];
        let after = after.trim_start_matches(|c: char| c == ':' || c == '：' || c.is_whitespace());
        return after.trim().to_string();
    }

    cleaned.to_string()
}

/// Byte offset where an unclosed reasoning block starts: the first opening tag that survived pair
/// removal, or a trailing fragment of that tag when the text ends inside it (for example `... <thi`
/// cut off by the token limit). `None` when the remaining text has no reasoning marker.
fn incomplete_reasoning_start(text: &str) -> Option<usize> {
    let tag = THINK_OPEN_TAG.as_bytes();
    if let Some(start) = text
        .as_bytes()
        .windows(tag.len())
        .position(|window| window.eq_ignore_ascii_case(tag))
    {
        return Some(start);
    }
    // A suffix that is a strict prefix of the opening tag can only be the tag itself cut off by
    // the end of the text; any other tail is ordinary text and stays visible.
    for length in 1..tag.len() {
        let Some(start) = text.len().checked_sub(length) else {
            break;
        };
        if text.is_char_boundary(start)
            && text[start..]
                .as_bytes()
                .eq_ignore_ascii_case(&tag[..length])
        {
            return Some(start);
        }
    }
    None
}

/// Accumulates the raw text of a streaming completion and yields only the user-visible part,
/// deduplicated: reasoning must not reach live captions, and an unchanged visible part must not
/// repaint them.
#[derive(Default)]
pub(super) struct VisibleStreamText {
    visible: String,
}

impl VisibleStreamText {
    /// Returns the visible text when this update changed it; `None` while the visible part is
    /// unchanged (for example while the model is still inside a reasoning block).
    pub(super) fn update(&mut self, raw: &str) -> Option<&str> {
        let visible = strip_thinking(raw);
        if visible == self.visible {
            return None;
        }
        self.visible = visible;
        Some(&self.visible)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Complete blocks are removed wherever they appear, regardless of tag case.
    #[test]
    fn removes_complete_think_blocks() {
        assert_eq!(strip_thinking("a<THINK>secret</Think>b"), "ab");
        assert_eq!(
            strip_thinking("<think>one</think>mid<think>two</think>"),
            "mid"
        );
    }

    /// While the model is still thinking the block has no closing tag yet; everything from the
    /// opening tag on stays hidden.
    #[test]
    fn hides_an_unclosed_think_block() {
        assert_eq!(strip_thinking("answer <think>still thinking"), "answer");
        assert_eq!(strip_thinking("<think>only reasoning"), "");
    }

    /// An opening tag cut off by the end of the text cannot be visible text either.
    #[test]
    fn hides_a_truncated_opening_tag() {
        assert_eq!(strip_thinking("answer <thi"), "answer");
        assert_eq!(strip_thinking("answer <think"), "answer");
        assert_eq!(strip_thinking("answer <this"), "answer <this");
    }

    /// A `<` that cannot grow into a reasoning tag is ordinary text.
    #[test]
    fn keeps_ordinary_angle_brackets() {
        assert_eq!(strip_thinking("a < b and a <= b"), "a < b and a <= b");
        assert_eq!(strip_thinking("a <t b"), "a <t b");
    }

    /// The "final answer" marker rule still applies after block removal.
    #[test]
    fn keeps_only_the_final_answer_after_the_marker() {
        assert_eq!(
            strip_thinking("draft <think>x</think> 最终答案: ready"),
            "ready"
        );
    }

    /// Live deltas stay silent while only reasoning streams.
    #[test]
    fn visible_deltas_stay_silent_while_only_reasoning_streams() {
        let mut visible = VisibleStreamText::default();
        assert_eq!(visible.update("<think>"), None);
        assert_eq!(visible.update("<think>plan"), None);
        assert_eq!(visible.update("<think>plan</thi"), None);
    }

    /// Live deltas fire only when the visible text changes.
    #[test]
    fn visible_deltas_fire_only_when_visible_text_changes() {
        let mut visible = VisibleStreamText::default();
        assert_eq!(visible.update("o"), Some("o"));
        assert_eq!(visible.update("o"), None);
        assert_eq!(visible.update("ok"), Some("ok"));
    }
}

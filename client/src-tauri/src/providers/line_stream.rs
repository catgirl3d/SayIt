// Shared incremental line-framed text stream for AI provider responses.
//
// The OpenAI-compatible SSE path and the Ollama NDJSON path differ only in how a
// complete line is interpreted. The buffering around them is identical: split on
// '\n', trim a trailing '\r', flush a trailing line that arrived without a
// newline, and stop at the protocol end marker. Keeping it in one place means a
// fix to the framing logic lands in both providers at once.

use futures_util::StreamExt;

use super::diag;
use super::reasoning::VisibleStreamText;

/// Result of interpreting one complete response line.
#[derive(Default)]
pub struct LineStep {
    /// Completion text carried by this line; appended to the accumulated text.
    pub delta: Option<String>,
    /// The protocol signalled end-of-stream on this line.
    pub done: bool,
}

/// Incremental parser scaffolding shared by SSE and NDJSON chat streams.
///
/// Feed raw network chunks with [`push`](Self::push); it calls `on_text` with the
/// accumulated text after every complete line that grew it. Network chunking
/// must not decide how many partials are delivered.
pub struct LineTextStream<P> {
    buffer: Vec<u8>,
    /// Text accumulated by the `parse_line` hook so far.
    pub text: String,
    /// Set once the protocol end marker has been seen.
    pub done: bool,
    parse_line: P,
}

impl<P: FnMut(&str) -> LineStep> LineTextStream<P> {
    pub fn new(parse_line: P) -> Self {
        Self {
            buffer: Vec::new(),
            text: String::new(),
            done: false,
            parse_line,
        }
    }

    /// Feeds one raw chunk and calls `on_text` with the accumulated text after
    /// every complete line that grew it.
    pub fn push(&mut self, chunk: &[u8], on_text: &mut dyn FnMut(&str)) {
        if self.done {
            return;
        }
        self.buffer.extend_from_slice(chunk);
        while let Some(newline) = self.buffer.iter().position(|byte| *byte == b'\n') {
            let mut line: Vec<u8> = self.buffer.drain(..=newline).collect();
            line.pop();
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            if self.apply_line(&line) {
                on_text(&self.text);
            }
        }
    }

    /// Processes a trailing line that arrived without a newline before the
    /// stream ended.
    pub fn finish(&mut self, on_text: &mut dyn FnMut(&str)) {
        if self.done || self.buffer.is_empty() {
            return;
        }
        let line = std::mem::take(&mut self.buffer);
        if self.apply_line(&line) {
            on_text(&self.text);
        }
    }

    fn apply_line(&mut self, line: &[u8]) -> bool {
        let line = String::from_utf8_lossy(line);
        let step = (self.parse_line)(&line);
        if step.done {
            self.done = true;
        }
        match step.delta {
            Some(delta) if !delta.is_empty() => {
                self.text.push_str(&delta);
                true
            }
            _ => false,
        }
    }
}

/// Drain a streamed HTTP response through a [`LineTextStream`], forwarding only
/// the user-visible text (reasoning blocks stay hidden) to `on_delta`.
pub async fn drain_text_stream<P>(
    resp: reqwest::Response,
    scope: &str,
    parse_line: P,
    mut on_delta: impl FnMut(&str),
) -> Result<String, String>
where
    P: FnMut(&str) -> LineStep,
{
    let mut stream = LineTextStream::new(parse_line);
    // Live subtitles must never see raw reasoning: every delta carries the
    // user-visible text, and only when it changed, so a thinking block stays
    // hidden while it streams.
    let mut visible = VisibleStreamText::default();
    let mut on_visible = |raw: &str| {
        if let Some(text) = visible.update(raw) {
            on_delta(text);
        }
    };
    let mut bytes = resp.bytes_stream();
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|e| {
            diag::fail(scope, "stream_read", format!("Failed to read stream: {}", e))
        })?;
        stream.push(&chunk, &mut on_visible);
        if stream.done {
            break;
        }
    }
    stream.finish(&mut on_visible);
    Ok(stream.text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stub framing used to pin the shared buffering: every non-empty line is a
    /// delta, `[END]` marks the end of the stream.
    fn stub_line_step(line: &str) -> LineStep {
        if line == "[END]" {
            return LineStep {
                delta: None,
                done: true,
            };
        }
        LineStep {
            delta: Some(line.to_string()),
            done: false,
        }
    }

    #[test]
    fn assembles_text_across_chunk_boundaries() {
        let body = "one\ntwo\n[END]\n";
        let mut stream = LineTextStream::new(stub_line_step);
        let mut snapshots: Vec<String> = Vec::new();
        for chunk in body.as_bytes().chunks(3) {
            stream.push(chunk, &mut |text| snapshots.push(text.to_string()));
        }

        assert_eq!(stream.text, "onetwo");
        assert_eq!(snapshots, vec!["one".to_string(), "onetwo".to_string()]);
        assert!(stream.done);
    }

    #[test]
    fn trims_crlf_and_ignores_empty_lines_and_empty_deltas() {
        let body = "one\r\n\r\ntwo\r\n[END]\r\n";
        let mut stream = LineTextStream::new(stub_line_step);
        let mut emitted = 0;

        stream.push(body.as_bytes(), &mut |_| emitted += 1);

        assert_eq!(emitted, 2);
        assert_eq!(stream.text, "onetwo");
        assert!(stream.done);
    }

    #[test]
    fn finish_delivers_a_trailing_line_without_a_newline() {
        let mut stream = LineTextStream::new(stub_line_step);
        let mut snapshots: Vec<String> = Vec::new();

        stream.push(b"tail", &mut |text| snapshots.push(text.to_string()));
        assert!(snapshots.is_empty());
        stream.finish(&mut |text| snapshots.push(text.to_string()));

        assert_eq!(snapshots, vec!["tail".to_string()]);
        assert_eq!(stream.text, "tail");
    }

    #[test]
    fn ignores_chunks_after_the_done_marker() {
        let mut stream = LineTextStream::new(stub_line_step);
        let mut snapshots: Vec<String> = Vec::new();

        stream.push(b"one\n[END]\n", &mut |text| snapshots.push(text.to_string()));
        stream.push(b"late\n", &mut |text| snapshots.push(text.to_string()));
        stream.finish(&mut |text| snapshots.push(text.to_string()));

        assert_eq!(snapshots, vec!["one".to_string()]);
        assert_eq!(stream.text, "one");
    }
}

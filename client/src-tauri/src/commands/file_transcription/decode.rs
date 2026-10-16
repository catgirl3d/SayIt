use super::ffmpeg::{STDERR_CAPTURE_LIMIT, ffmpeg_command};
use super::job::{WorkerInput, WorkerOutcome};
use super::pcm::decoded_pcm_sample_count;
use super::state::{
    ChildControl, clear_process, register_process, take_child_pipes, update_active,
};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Child, ExitStatus};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use transcribe_cpp::CancelToken;

fn parse_ffmpeg_progress_line(line: &str) -> Option<u64> {
    let value = line.trim().strip_prefix("out_time_us=")?.trim();
    let microseconds = value.parse::<u64>().ok()?;
    Some(microseconds / 1000)
}

fn is_ffmpeg_progress_line(line: &str) -> bool {
    matches!(
        line.split_once('=').map(|(key, _)| key),
        Some(
            "frame"
                | "fps"
                | "stream_0_0_q"
                | "bitrate"
                | "total_size"
                | "out_time_us"
                | "out_time_ms"
                | "out_time"
                | "dup_frames"
                | "drop_frames"
                | "speed"
                | "progress"
        )
    )
}

fn read_ffmpeg_progress<R: Read>(mut reader: R, progress: Sender<u64>) -> Result<Vec<u8>, String> {
    let mut pending = Vec::new();
    let mut captured = Vec::new();
    let mut too_much_output = false;
    let mut buffer = [0_u8; 16 * 1024];
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read FFmpeg progress output: {error}"))?;
        if count == 0 {
            break;
        }
        pending.extend_from_slice(&buffer[..count]);
        if pending.len() > STDERR_CAPTURE_LIMIT {
            pending.clear();
            too_much_output = true;
        }
        while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
            let line = pending.drain(..=newline).collect::<Vec<_>>();
            let line = String::from_utf8_lossy(&line);
            if let Some(milliseconds) = parse_ffmpeg_progress_line(&line) {
                let _ = progress.send(milliseconds);
            }
            if !is_ffmpeg_progress_line(&line) {
                if captured.len().saturating_add(line.len()) <= STDERR_CAPTURE_LIMIT {
                    captured.extend_from_slice(line.as_bytes());
                } else {
                    too_much_output = true;
                }
            }
        }
    }
    if !pending.is_empty() {
        let line = String::from_utf8_lossy(&pending);
        if let Some(milliseconds) = parse_ffmpeg_progress_line(&line) {
            let _ = progress.send(milliseconds);
        }
        if !is_ffmpeg_progress_line(&line) {
            if captured.len().saturating_add(line.len()) <= STDERR_CAPTURE_LIMIT {
                captured.extend_from_slice(line.as_bytes());
            } else {
                too_much_output = true;
            }
        }
    }
    if too_much_output {
        return Err("FFmpeg produced too much progress output".into());
    }
    Ok(captured)
}

fn publish_ffmpeg_progress(job_id: &str, progress: &Receiver<u64>) {
    for milliseconds in progress.try_iter() {
        let _ = update_active(job_id, |snapshot| {
            snapshot.processed_ms = snapshot.processed_ms.max(milliseconds);
        });
    }
}

pub(super) fn read_decoded_audio(
    input: &WorkerInput,
    source: &Path,
    track: usize,
    pcm_path: &Path,
) -> Result<(), WorkerOutcome> {
    if input.cancel.is_cancelled() {
        return Err(WorkerOutcome::Cancelled);
    }
    let mut command = ffmpeg_command(&input.tools, source, track);
    let child = command.spawn().map_err(|error| {
        WorkerOutcome::Failed(format!(
            "Failed to start FFmpeg. Choose a folder containing FFmpeg and FFprobe, or reinstall SayIt: {error}"
        ))
    })?;
    supervise_decoded_audio(&input.job_id, &input.cancel, child, pcm_path)
}

/// Owns the spawned decoder until it is reaped: takes its pipes, streams the
/// PCM into `pcm_path`, and guarantees that a running process is killed, waited
/// on, and its stderr reader joined before the outcome is classified.
fn supervise_decoded_audio(
    job_id: &str,
    cancel: &CancelToken,
    mut child: Child,
    pcm_path: &Path,
) -> Result<(), WorkerOutcome> {
    let (stdout, stderr) = take_child_pipes(
        &mut child,
        "FFmpeg stdout was not available for PCM decoding",
        "FFmpeg stderr was not available for PCM decoding",
    )
    .map_err(WorkerOutcome::Failed)?;
    let control = ChildControl::new(child);
    register_process(job_id, &control);
    let (progress_sender, progress_receiver) = mpsc::channel();
    let stderr_thread = match thread::Builder::new()
        .name("ffmpeg-stderr".into())
        .spawn(move || read_ffmpeg_progress(stderr, progress_sender))
    {
        Ok(handle) => handle,
        Err(error) => {
            control.kill();
            return Err(WorkerOutcome::Failed(format!(
                "Failed to start the FFmpeg stderr reader: {error}"
            )));
        }
    };
    let result = (|| -> Result<(), WorkerOutcome> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(pcm_path)
            .map_err(|error| {
                WorkerOutcome::Failed(format!("Failed to create temporary PCM: {error}"))
            })?;
        drain_pcm_output(
            stdout,
            &mut output,
            job_id,
            cancel,
            &control,
            &progress_receiver,
        )?;
        output.sync_all().map_err(|error| {
            WorkerOutcome::Failed(format!("Failed to sync temporary PCM: {error}"))
        })?;
        drop(output);
        Ok(())
    })();
    if result.is_err() {
        control.kill();
    }
    let status = control.wait().map_err(WorkerOutcome::Failed);
    let stderr = stderr_thread
        .join()
        .map_err(|_| WorkerOutcome::Failed("FFmpeg stderr reader failed".into()))
        .and_then(|result| result.map_err(WorkerOutcome::Failed));
    publish_ffmpeg_progress(job_id, &progress_receiver);
    clear_process(job_id);
    result?;
    let status = status?;
    let stderr = stderr?;
    decoder_exit_outcome(cancel, status, &stderr, pcm_path)
}

/// Streams the decoder stdout into the PCM sink. Cancellation is checked
/// between reads: the process is killed on the first observed cancellation and
/// the already buffered output is still drained to EOF.
fn drain_pcm_output<R: Read, W: Write>(
    mut reader: R,
    output: &mut W,
    job_id: &str,
    cancel: &CancelToken,
    control: &ChildControl,
    progress: &Receiver<u64>,
) -> Result<(), WorkerOutcome> {
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        publish_ffmpeg_progress(job_id, progress);
        if cancel.is_cancelled() {
            control.kill();
        }
        let count = reader.read(&mut buffer).map_err(|error| {
            WorkerOutcome::Failed(format!("Failed to read FFmpeg PCM output: {error}"))
        })?;
        if count == 0 {
            break;
        }
        output.write_all(&buffer[..count]).map_err(|error| {
            WorkerOutcome::Failed(format!("Failed to write temporary PCM: {error}"))
        })?;
    }
    publish_ffmpeg_progress(job_id, progress);
    Ok(())
}

/// The final decision for a reaped decoder: an accepted cancellation wins over
/// the process outcome, then the exit status and the PCM sample count decide.
fn decoder_exit_outcome(
    cancel: &CancelToken,
    status: ExitStatus,
    stderr: &[u8],
    pcm_path: &Path,
) -> Result<(), WorkerOutcome> {
    if cancel.is_cancelled() {
        return Err(WorkerOutcome::Cancelled);
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(stderr).trim().to_string();
        return Err(WorkerOutcome::Failed(if detail.is_empty() {
            "FFmpeg could not decode the selected audio track; check that the installed build supports this codec".into()
        } else {
            format!("FFmpeg could not decode the selected audio track: {detail}")
        }));
    }
    decoded_pcm_sample_count(pcm_path)
        .map(|_| ())
        .map_err(WorkerOutcome::Failed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::file_transcription::test_support::{test_dir, test_path, worker_input};
    #[cfg(windows)]
    use std::process::{Command, Stdio};
    use std::time::Duration;

    #[test]
    fn preparation_progress_parser_accepts_only_truthful_out_time() {
        assert_eq!(
            parse_ffmpeg_progress_line("out_time_us=1250000"),
            Some(1_250)
        );
        assert_eq!(parse_ffmpeg_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_ffmpeg_progress_line("frame=42"), None);
    }

    #[test]
    fn progress_reader_forwards_out_time_and_captures_diagnostics() {
        let mut input = Vec::new();
        input.extend_from_slice(b"frame=42\nout_time_us=2500000\n");
        input.extend_from_slice(b"Problem: stream mapping failed\n");
        input.extend_from_slice(b"out_time_us=N/A");
        let (sender, receiver) = mpsc::channel();

        let captured = read_ffmpeg_progress(std::io::Cursor::new(input), sender).unwrap();

        let lines = String::from_utf8(captured).unwrap();
        assert_eq!(lines, "Problem: stream mapping failed\n");
        let forwarded = receiver.try_iter().collect::<Vec<u64>>();
        assert_eq!(forwarded, vec![2_500]);
    }

    #[test]
    fn progress_reader_rejects_output_beyond_the_capture_limit() {
        let (sender, _receiver) = mpsc::channel();
        let mut overflowing = vec![b'x'; STDERR_CAPTURE_LIMIT + 1];
        overflowing.push(b'\n');
        let error = read_ffmpeg_progress(std::io::Cursor::new(overflowing), sender).unwrap_err();
        assert!(
            error.contains("too much progress output"),
            "unexpected error: {error}"
        );

        let (sender, _receiver) = mpsc::channel();
        let mut fitting = vec![b'y'; STDERR_CAPTURE_LIMIT - 1];
        fitting.push(b'\n');
        let captured = read_ffmpeg_progress(std::io::Cursor::new(fitting), sender).unwrap();
        assert_eq!(captured.len(), STDERR_CAPTURE_LIMIT);
    }

    #[test]
    fn decoder_spawn_failure_reports_the_sidecar_or_override_hint() {
        let dir = test_dir("decode-spawn-failure");
        let input = worker_input(
            "job-spawn-failure",
            &dir.join("movie.mp4"),
            &dir,
            test_path("spawn-failure-temp"),
        );
        let pcm_path = dir.join("decoded.pcm");

        let outcome = read_decoded_audio(&input, &dir.join("movie.mp4"), 0, &pcm_path);

        let Err(WorkerOutcome::Failed(message)) = outcome else {
            panic!("expected a start failure");
        };
        assert!(
            message.contains("Failed to start FFmpeg"),
            "unexpected error: {message}"
        );
        assert!(
            message.contains("Choose a folder containing FFmpeg and FFprobe, or reinstall SayIt"),
            "unexpected error: {message}"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[cfg(windows)]
    fn inert_child() -> ChildControl {
        ChildControl::new(
            Command::new("cmd")
                .args(["/C", "exit 0"])
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        )
    }

    #[test]
    #[cfg(windows)]
    fn drain_copies_all_bytes_to_the_sink() {
        let (sender, receiver) = mpsc::channel();
        let cancel = CancelToken::new();
        let control = inert_child();
        let mut sink = Vec::new();

        drain_pcm_output(
            std::io::Cursor::new(b"pcm-bytes".to_vec()),
            &mut sink,
            "job-drain",
            &cancel,
            &control,
            &receiver,
        )
        .unwrap();

        assert_eq!(sink, b"pcm-bytes");
        drop(sender);
    }

    #[test]
    #[cfg(windows)]
    fn drain_surfaces_a_read_failure() {
        struct FailingReader;

        impl Read for FailingReader {
            fn read(&mut self, _buffer: &mut [u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("read broken"))
            }
        }

        let (_sender, receiver) = mpsc::channel();
        let cancel = CancelToken::new();
        let control = inert_child();

        let outcome = drain_pcm_output(
            FailingReader,
            &mut Vec::new(),
            "job-drain",
            &cancel,
            &control,
            &receiver,
        );

        let Err(WorkerOutcome::Failed(message)) = outcome else {
            panic!("expected a read failure");
        };
        assert!(
            message.contains("Failed to read FFmpeg PCM output"),
            "unexpected error: {message}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn drain_surfaces_a_write_failure() {
        struct FailingWriter;

        impl Write for FailingWriter {
            fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("disk full"))
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let (_sender, receiver) = mpsc::channel();
        let cancel = CancelToken::new();
        let control = inert_child();

        let outcome = drain_pcm_output(
            std::io::Cursor::new(b"data".to_vec()),
            &mut FailingWriter,
            "job-drain",
            &cancel,
            &control,
            &receiver,
        );

        let Err(WorkerOutcome::Failed(message)) = outcome else {
            panic!("expected a write failure");
        };
        assert!(
            message.contains("Failed to write temporary PCM"),
            "unexpected error: {message}"
        );
    }

    #[test]
    #[cfg(windows)]
    fn drain_kills_the_process_when_cancellation_was_already_accepted() {
        let (_sender, receiver) = mpsc::channel();
        let cancel = CancelToken::new();
        cancel.cancel();
        let control = ChildControl::new(
            Command::new("ping")
                .args(["127.0.0.1", "-n", "8"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .unwrap(),
        );

        drain_pcm_output(
            std::io::Cursor::new(Vec::new()),
            &mut Vec::new(),
            "job-drain-cancel",
            &cancel,
            &control,
            &receiver,
        )
        .unwrap();

        let status = control
            .wait()
            .expect("the killed process must still be waitable");
        assert!(
            !status.success(),
            "an accepted cancellation must kill the process"
        );
    }

    #[test]
    #[cfg(windows)]
    fn decoder_exit_classification_covers_cancellation_failure_and_pcm_check() {
        use std::os::windows::process::ExitStatusExt;

        let dir = test_dir("decode-classify");
        let pcm_path = dir.join("decoded.pcm");
        let cancel = CancelToken::new();
        let success = ExitStatus::from_raw(0);
        let failure = ExitStatus::from_raw(1);

        let error = decoder_exit_outcome(&cancel, failure, b"", &pcm_path).unwrap_err();
        let WorkerOutcome::Failed(message) = error else {
            panic!("expected a failure");
        };
        assert!(
            message.contains("supports this codec"),
            "unexpected error: {message}"
        );

        let error = decoder_exit_outcome(&cancel, failure, b"  codec not found  \n", &pcm_path)
            .unwrap_err();
        let WorkerOutcome::Failed(message) = error else {
            panic!("expected a failure");
        };
        assert!(
            message.contains("codec not found"),
            "unexpected error: {message}"
        );

        std::fs::write(&pcm_path, b"").unwrap();
        let error = decoder_exit_outcome(&cancel, success, b"", &pcm_path).unwrap_err();
        let WorkerOutcome::Failed(message) = error else {
            panic!("expected a failure");
        };
        assert!(
            message.contains("empty decoded audio"),
            "unexpected error: {message}"
        );

        std::fs::write(&pcm_path, [0_u8, 0, 1, 0]).unwrap();
        decoder_exit_outcome(&cancel, success, b"", &pcm_path).unwrap();

        cancel.cancel();
        let outcome = decoder_exit_outcome(&cancel, success, b"stderr", &pcm_path);
        assert!(matches!(outcome, Err(WorkerOutcome::Cancelled)));

        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    #[cfg(windows)]
    fn cancelled_decoding_kills_the_process_instead_of_waiting_for_it() {
        let dir = test_dir("decode-cancel-lifecycle");
        let pcm_path = dir.join("decoded.pcm");
        let cancel = CancelToken::new();
        let child = Command::new("ping")
            .args(["127.0.0.1", "-n", "30"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let canceller = cancel.clone();
        let trigger = thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            canceller.cancel();
        });
        let started = std::time::Instant::now();

        let outcome = supervise_decoded_audio("job-decode-cancel", &cancel, child, &pcm_path);
        let elapsed = started.elapsed();
        trigger.join().unwrap();

        assert!(
            matches!(outcome, Err(WorkerOutcome::Cancelled)),
            "expected a cancellation"
        );
        assert!(
            elapsed < Duration::from_secs(8),
            "the decoder must be killed instead of running to its natural end, elapsed {elapsed:?}"
        );
        let decoded = std::fs::read(&pcm_path).unwrap();
        assert!(
            !decoded.is_empty(),
            "the bytes read before the kill must stay in the PCM file"
        );
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    #[cfg(windows)]
    fn supervise_reports_missing_pipes_with_exact_messages() {
        let dir = test_dir("decode-missing-pipes");
        let pcm_path = dir.join("decoded.pcm");
        let cancel = CancelToken::new();

        let child = Command::new("cmd")
            .args(["/D", "/C", "exit 0"])
            .spawn()
            .unwrap();
        let outcome = supervise_decoded_audio("job-missing-stdout", &cancel, child, &pcm_path);
        let Err(WorkerOutcome::Failed(message)) = outcome else {
            panic!("expected a stdout pipe failure");
        };
        assert_eq!(message, "FFmpeg stdout was not available for PCM decoding");

        let mut command = Command::new("cmd");
        command.args(["/D", "/C", "exit 0"]).stdout(Stdio::piped());
        let child = command.spawn().unwrap();
        let outcome = supervise_decoded_audio("job-missing-stderr", &cancel, child, &pcm_path);
        let Err(WorkerOutcome::Failed(message)) = outcome else {
            panic!("expected a stderr pipe failure");
        };
        assert_eq!(message, "FFmpeg stderr was not available for PCM decoding");

        std::fs::remove_dir_all(dir).ok();
    }
}

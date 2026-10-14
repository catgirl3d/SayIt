use super::ffmpeg::{STDERR_CAPTURE_LIMIT, ffmpeg_command};
use super::job::{WorkerInput, WorkerOutcome};
use super::pcm::decoded_pcm_sample_count;
use super::state::{ChildControl, clear_process, register_process, update_active};
use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::Path;
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

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
    let mut child = command.spawn().map_err(|error| {
        WorkerOutcome::Failed(format!(
            "Failed to start FFmpeg. Install a working FFmpeg build or select its folder: {error}"
        ))
    })?;
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(WorkerOutcome::Failed(
                "FFmpeg stdout was not available for PCM decoding".into(),
            ));
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(WorkerOutcome::Failed(
                "FFmpeg stderr was not available for PCM decoding".into(),
            ));
        }
    };
    let control = ChildControl::new(child);
    register_process(&input.job_id, &control);
    let (progress_sender, progress_receiver) = mpsc::channel();
    let stderr_thread = thread::spawn(move || read_ffmpeg_progress(stderr, progress_sender));
    let result = (|| -> Result<(), WorkerOutcome> {
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(pcm_path)
            .map_err(|error| {
                WorkerOutcome::Failed(format!("Failed to create temporary PCM: {error}"))
            })?;
        let mut reader = stdout;
        let mut buffer = [0_u8; 64 * 1024];
        loop {
            publish_ffmpeg_progress(&input.job_id, &progress_receiver);
            if input.cancel.is_cancelled() {
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
        publish_ffmpeg_progress(&input.job_id, &progress_receiver);
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
    publish_ffmpeg_progress(&input.job_id, &progress_receiver);
    clear_process(&input.job_id);
    result?;
    let status = status?;
    let stderr = stderr?;
    if input.cancel.is_cancelled() {
        return Err(WorkerOutcome::Cancelled);
    }
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr).trim().to_string();
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

    #[test]
    fn preparation_progress_parser_accepts_only_truthful_out_time() {
        assert_eq!(
            parse_ffmpeg_progress_line("out_time_us=1250000"),
            Some(1_250)
        );
        assert_eq!(parse_ffmpeg_progress_line("out_time_us=N/A"), None);
        assert_eq!(parse_ffmpeg_progress_line("frame=42"), None);
    }
}

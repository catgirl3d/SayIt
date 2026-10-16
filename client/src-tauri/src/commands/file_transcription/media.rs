use super::contract::{FileAudioTrack, FileMediaInfo};
use super::ffmpeg::{STDERR_CAPTURE_LIMIT, ToolPaths, ffprobe_command};
use super::state::{
    ChildControl, JobProcessContext, clear_process, register_process, take_child_pipes,
};
use serde_json::Value;
use std::io::Read;
use std::path::Path;
use std::process::{Command, ExitStatus};
use std::thread;

const PROBE_STDOUT_LIMIT: usize = 2 * 1024 * 1024;

fn parse_duration_ms(value: Option<&Value>) -> Option<u64> {
    let seconds = value.and_then(|value| {
        value
            .as_f64()
            .or_else(|| value.as_str().and_then(|text| text.parse::<f64>().ok()))
    })?;
    if !seconds.is_finite() || seconds <= 0.0 {
        return None;
    }
    Some((seconds * 1000.0).round() as u64)
}

fn value_string(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).map(str::to_string)
}

pub(super) fn select_audio_track(
    tracks: &[FileAudioTrack],
    requested: Option<usize>,
) -> Result<usize, String> {
    if tracks.is_empty() {
        return Err("The media file contains no audio track".into());
    }
    if let Some(index) = requested {
        if tracks.iter().any(|track| track.index == index) {
            return Ok(index);
        }
        return Err(format!(
            "Audio track {index} does not exist; choose a track from the inspected media file"
        ));
    }
    Ok(tracks
        .iter()
        .find(|track| track.is_default)
        .map(|track| track.index)
        .unwrap_or(tracks[0].index))
}

fn parse_probe(stdout: &[u8]) -> Result<FileMediaInfo, String> {
    let document: Value = serde_json::from_slice(stdout)
        .map_err(|error| format!("FFprobe returned invalid media metadata: {error}"))?;
    let streams = document
        .get("streams")
        .and_then(Value::as_array)
        .ok_or_else(|| "FFprobe returned no stream metadata".to_string())?;
    let mut audio_tracks = Vec::new();
    for stream in streams {
        if stream.get("codec_type").and_then(Value::as_str) != Some("audio") {
            continue;
        }
        let index = audio_tracks.len();
        let tags = stream.get("tags").and_then(Value::as_object);
        let label = tags
            .and_then(|tags| {
                ["title", "handler_name", "language"]
                    .into_iter()
                    .find_map(|key| tags.get(key).and_then(Value::as_str))
            })
            .map(str::to_string)
            .or_else(|| value_string(stream.get("codec_name")))
            .unwrap_or_else(|| format!("Audio track {}", index + 1));
        let is_default = stream
            .get("disposition")
            .and_then(|disposition| disposition.get("default"))
            .is_some_and(|value| value.as_i64() == Some(1) || value.as_bool() == Some(true));
        audio_tracks.push(FileAudioTrack {
            index,
            label,
            is_default,
        });
    }
    if audio_tracks.is_empty() {
        return Err("The media file contains no audio stream".into());
    }
    let duration_ms = document
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|duration| parse_duration_ms(Some(duration)))
        .or_else(|| {
            streams.iter().find_map(|stream| {
                (stream.get("codec_type").and_then(Value::as_str) == Some("audio"))
                    .then(|| parse_duration_ms(stream.get("duration")))?
            })
        });
    Ok(FileMediaInfo {
        duration_ms,
        audio_tracks,
    })
}

fn read_capped<R: Read>(
    mut reader: R,
    limit: usize,
    control: Option<ChildControl>,
) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0_u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        let count = reader
            .read(&mut buffer)
            .map_err(|error| format!("Failed to read media process output: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = limit.saturating_sub(bytes.len());
        if remaining > 0 {
            let keep = remaining.min(count);
            bytes.extend_from_slice(&buffer[..keep]);
        }
        if count > remaining {
            exceeded = true;
            if let Some(control) = &control {
                control.kill();
            }
        }
    }
    if exceeded {
        return Err("Media process produced too much metadata output".into());
    }
    Ok(bytes)
}

fn run_probe_command(
    mut command: Command,
    context: Option<JobProcessContext<'_>>,
) -> Result<(ExitStatus, Vec<u8>, Vec<u8>), String> {
    let mut child = command
        .spawn()
        .map_err(|error| format!("Failed to start FFprobe: {error}"))?;
    let (stdout, stderr) = take_child_pipes(
        &mut child,
        "FFprobe stdout was not available",
        "FFprobe stderr was not available",
    )?;
    let control = ChildControl::new(child);
    if let Some(context) = context.as_ref() {
        register_process(context.job_id, &control);
    }
    let stdout_control = Some(control.clone());
    let stdout_thread = match thread::Builder::new()
        .name("ffprobe-stdout".into())
        .spawn(move || read_capped(stdout, PROBE_STDOUT_LIMIT, stdout_control))
    {
        Ok(handle) => handle,
        Err(error) => {
            control.kill();
            return Err(format!(
                "Failed to start the FFprobe stdout reader: {error}"
            ));
        }
    };
    let stderr_thread = match thread::Builder::new()
        .name("ffprobe-stderr".into())
        .spawn(move || read_capped(stderr, STDERR_CAPTURE_LIMIT, None))
    {
        Ok(handle) => handle,
        Err(error) => {
            control.kill();
            return Err(format!(
                "Failed to start the FFprobe stderr reader: {error}"
            ));
        }
    };
    let status = control.wait();
    let output = stdout_thread
        .join()
        .map_err(|_| "FFprobe stdout reader failed".to_string());
    let error_output = stderr_thread
        .join()
        .map_err(|_| "FFprobe stderr reader failed".to_string());
    if let Some(context) = context {
        clear_process(context.job_id);
        if context.cancel.is_cancelled() {
            return Err("File transcription was cancelled".into());
        }
    }
    Ok((status?, output??, error_output??))
}

pub(super) fn probe_media(
    source: &Path,
    tools: &ToolPaths,
    context: Option<JobProcessContext<'_>>,
) -> Result<FileMediaInfo, String> {
    let (status, stdout, stderr) = run_probe_command(ffprobe_command(tools, source), context)?;
    if !status.success() {
        let detail = String::from_utf8_lossy(&stderr);
        let detail = detail.trim();
        if detail.is_empty() {
            return Err("FFprobe could not read the selected media file".into());
        }
        return Err(format!(
            "FFprobe could not read the selected media file: {detail}"
        ));
    }
    parse_probe(&stdout)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_track_selection_prefers_default_and_honors_valid_request() {
        let tracks = vec![
            FileAudioTrack {
                index: 0,
                label: "commentary".into(),
                is_default: false,
            },
            FileAudioTrack {
                index: 1,
                label: "main".into(),
                is_default: true,
            },
        ];

        assert_eq!(select_audio_track(&tracks, None).unwrap(), 1);
        assert_eq!(select_audio_track(&tracks, Some(0)).unwrap(), 0);
        assert!(select_audio_track(&tracks, Some(2)).is_err());
    }

    #[test]
    fn probe_parser_returns_audio_tracks_and_exact_metadata_duration() {
        let media = parse_probe(
            br#"{
                "streams": [
                    {"index": 0, "codec_type": "video"},
                    {"index": 1, "codec_type": "audio", "codec_name": "aac", "tags": {"language": "eng"}, "disposition": {"default": 0}, "duration": "11.25"},
                    {"index": 2, "codec_type": "audio", "codec_name": "pcm_s16le", "tags": {"title": "Main"}, "disposition": {"default": 1}}
                ],
                "format": {"duration": "12.345"}
            }"#,
        )
        .unwrap();
        assert_eq!(media.duration_ms, Some(12_345));
        assert_eq!(media.audio_tracks[0].index, 0);
        assert_eq!(media.audio_tracks[0].label, "eng");
        assert!(!media.audio_tracks[0].is_default);
        assert_eq!(media.audio_tracks[1].label, "Main");
        assert!(media.audio_tracks[1].is_default);
    }

    #[test]
    fn capped_process_output_rejects_only_bytes_beyond_the_limit() {
        assert_eq!(read_capped(&b"1234"[..], 4, None).unwrap(), b"1234");
        assert!(read_capped(&b"12345"[..], 4, None).is_err());
    }

    #[test]
    #[cfg(windows)]
    fn probe_command_reports_missing_output_pipes() {
        use std::process::Stdio;

        // Only the error branches are observable here: the kill/wait fallback
        // cannot be distinguished from reaping a child that already exited.
        let mut command = Command::new("cmd");
        command.args(["/D", "/C", "exit 0"]).stdout(Stdio::null());
        let error = run_probe_command(command, None).unwrap_err();
        assert!(
            error.contains("stdout was not available"),
            "unexpected error: {error}"
        );

        let mut command = Command::new("cmd");
        command
            .args(["/D", "/C", "exit 0"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let error = run_probe_command(command, None).unwrap_err();
        assert!(
            error.contains("stderr was not available"),
            "unexpected error: {error}"
        );
    }
}

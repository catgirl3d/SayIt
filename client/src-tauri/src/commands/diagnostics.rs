use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::io::{Read, Seek, Write};
use std::path::{Path, PathBuf};

fn log_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.sayit.app")
        .join("logs")
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PreviewRequest {
    #[serde(rename = "issueOccurrence")]
    issue_occurrence: String,
}

#[derive(Serialize)]
struct DiagnosticsPreview {
    #[serde(rename = "generatedAt")]
    generated_at: String,
    #[serde(rename = "retentionDays")]
    retention_days: i32,
    #[serde(rename = "filesScanned")]
    files_scanned: usize,
    #[serde(rename = "totalRawEvents")]
    total_raw_events: usize,
    #[serde(rename = "totalTimelineEntries")]
    total_timeline_entries: usize,
    #[serde(rename = "issueWindowLabel")]
    issue_window_label: String,
    #[serde(rename = "rangeStart", skip_serializing_if = "Option::is_none")]
    range_start: Option<String>,
    #[serde(rename = "rangeEnd", skip_serializing_if = "Option::is_none")]
    range_end: Option<String>,
    #[serde(rename = "systemInfo")]
    system_info: SystemInfo,
    summary: Summary,
    timeline: Vec<TimelineEntry>,
}

#[derive(Serialize)]
struct SystemInfo {
    platform: String,
    #[serde(rename = "appVersion")]
    app_version: String,
    #[serde(rename = "webviewVersion")]
    webview_version: String,
}

#[derive(Serialize)]
struct Summary {
    errors: usize,
    warnings: usize,
    modules: Vec<ModuleCount>,
    #[serde(rename = "lastError", skip_serializing_if = "Option::is_none")]
    last_error: Option<TimelineEntry>,
}

#[derive(Serialize, Clone)]
struct ModuleCount {
    module: String,
    count: usize,
}

#[derive(Serialize, Clone)]
struct TimelineEntry {
    ts: String,
    level: String,
    module: String,
    title: String,
    detail: Option<String>,
    #[serde(rename = "traceId")]
    trace_id: Option<String>,
}

fn parse_log_line(line: &str) -> Option<TimelineEntry> {
    let line = line.trim();
    if !line.starts_with('[') {
        return None;
    }
    let ts_end = line.find(']')?;
    let ts = line[1..ts_end].trim_start_matches('[').trim();
    if ts.is_empty() || !ts.as_bytes()[0].is_ascii_digit() {
        return None;
    }
    let rest = line[ts_end + 1..].trim_start();
    if !rest.starts_with('[') {
        return None;
    }
    let level_end = rest.find(']')?;
    let level = rest[1..level_end].trim().to_lowercase();
    let rest = rest[level_end + 1..].trim_start();
    let (module, title) = if rest.starts_with('[') {
        let end = rest.find(']')?;
        (
            rest[1..end].trim().to_string(),
            rest[end + 1..].trim().to_string(),
        )
    } else {
        ("unknown".to_string(), rest.to_string())
    };
    Some(TimelineEntry {
        ts: ts.to_string(),
        level,
        module,
        title,
        detail: None,
        trace_id: None,
    })
}

fn issue_window_label(occurrence: &str) -> &'static str {
    match occurrence {
        "just_now" => "Just now",
        "within_1h" => "Within 1 hour",
        "today" => "Today",
        "yesterday" => "Yesterday",
        "older" => "Earlier",
        _ => "Unknown",
    }
}

fn occurrence_cutoff(occurrence: &str) -> Option<chrono::DateTime<chrono::Local>> {
    let now = chrono::Local::now();
    match occurrence {
        "just_now" => Some(now - chrono::Duration::minutes(10)),
        "within_1h" => Some(now - chrono::Duration::hours(1)),
        "today" => now
            .date_naive()
            .and_hms_opt(0, 0, 0)
            .and_then(|v| v.and_local_timezone(chrono::Local).earliest()),
        "yesterday" => (now.date_naive() - chrono::Duration::days(1))
            .and_hms_opt(0, 0, 0)
            .and_then(|v| v.and_local_timezone(chrono::Local).earliest()),
        _ => None,
    }
}

fn filter_entries_by_occurrence(entries: &[TimelineEntry], occurrence: &str) -> Vec<TimelineEntry> {
    let Some(cutoff) = occurrence_cutoff(occurrence) else {
        return entries.to_vec();
    };
    entries
        .iter()
        .filter(|entry| {
            parse_timestamp_candidates(&entry.ts)
                .is_some_and(|candidates| candidates.any_at_or_after(cutoff))
        })
        .cloned()
        .collect()
}

fn read_and_parse_logs() -> (Vec<TimelineEntry>, usize) {
    let mut entries = Vec::new();
    let mut files_scanned = 0;
    for filename in ["sayit.log", "sayit.1.log", "sayit.2.log", "sayit.3.log"] {
        let path = log_dir().join(filename);
        if !path.exists() {
            continue;
        }
        files_scanned += 1;
        if let Ok(content) = std::fs::read_to_string(path) {
            entries.extend(content.lines().filter_map(parse_log_line));
        }
    }
    entries.sort_by(|a, b| a.ts.cmp(&b.ts));
    (entries, files_scanned)
}

#[tauri::command]
pub fn get_diagnostics_preview(data: Value) -> Result<Value, String> {
    let req: PreviewRequest = serde_json::from_value(data).map_err(|e| e.to_string())?;
    let (all_entries, files_scanned) = read_and_parse_logs();
    let entries = filter_entries_by_occurrence(&all_entries, &req.issue_occurrence);
    let errors = entries.iter().filter(|e| e.level == "error").count();
    let warnings = entries
        .iter()
        .filter(|e| e.level == "warn" || e.level == "warning")
        .count();
    let mut module_map = std::collections::HashMap::new();
    for entry in &entries {
        *module_map.entry(entry.module.clone()).or_insert(0usize) += 1;
    }
    let mut modules: Vec<ModuleCount> = module_map
        .into_iter()
        .map(|(module, count)| ModuleCount { module, count })
        .collect();
    modules.sort_by(|a, b| b.count.cmp(&a.count));
    let last_error = entries.iter().rev().find(|e| e.level == "error").cloned();
    let timeline = entries
        .iter()
        .rev()
        .take(200)
        .rev()
        .cloned()
        .collect::<Vec<_>>();
    let preview = DiagnosticsPreview {
        generated_at: chrono::Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
        retention_days: 7,
        files_scanned,
        total_raw_events: all_entries.len(),
        total_timeline_entries: timeline.len(),
        issue_window_label: issue_window_label(&req.issue_occurrence).to_string(),
        range_start: entries.first().map(|e| e.ts.clone()),
        range_end: entries.last().map(|e| e.ts.clone()),
        system_info: SystemInfo {
            platform: std::env::consts::OS.to_string(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            webview_version: "WebView2".to_string(),
        },
        summary: Summary {
            errors,
            warnings,
            modules,
            last_error,
        },
        timeline,
    };
    serde_json::to_value(preview).map_err(|e| e.to_string())
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct PublicBundleRequest {
    #[serde(rename = "issueOccurrence")]
    issue_occurrence: String,
    environment: PublicEnvironmentInput,
}

#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct PublicEnvironmentInput {
    #[serde(rename = "workMode")]
    work_mode: String,
    #[serde(rename = "speechInputLanguage")]
    speech_input_language: String,
    #[serde(rename = "aiEnabled")]
    ai_enabled: bool,
    #[serde(rename = "asrProvider")]
    asr_provider: String,
    #[serde(rename = "aiProvider")]
    ai_provider: String,
    #[serde(rename = "localAccelerator")]
    local_accelerator: String,
}

#[derive(Serialize)]
struct PublicEnvironment {
    #[serde(rename = "workMode")]
    work_mode: &'static str,
    #[serde(rename = "speechInputLanguage")]
    speech_input_language: &'static str,
    #[serde(rename = "aiEnabled")]
    ai_enabled: bool,
    #[serde(rename = "asrProvider")]
    asr_provider: &'static str,
    #[serde(rename = "aiProvider")]
    ai_provider: &'static str,
    #[serde(rename = "localAccelerator")]
    local_accelerator: &'static str,
}

#[derive(Serialize)]
struct PublicEvent {
    #[serde(rename = "ageMinutes")]
    age_minutes: u64,
    severity: &'static str,
    category: &'static str,
    #[serde(rename = "eventKind")]
    event_kind: &'static str,
    #[serde(rename = "errorCode", skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}

const MAX_LOG_BYTES: usize = 512 * 1024;
const MAX_LINE_BYTES: usize = 4096;
const MAX_LINES: usize = 10_000;
const MAX_EVENTS: usize = 500;
const MAX_ARCHIVE_BYTES: usize = 512 * 1024;

fn normalize_enum(value: &str, allowed: &[&'static str]) -> &'static str {
    allowed
        .iter()
        .copied()
        .find(|candidate| *candidate == value)
        .unwrap_or("unknown")
}

fn normalize_language(value: &str) -> &'static str {
    [
        "auto", "en", "zh-CN", "ja", "ko", "ru", "uk", "de", "fr", "es", "pt", "it",
    ]
    .iter()
    .copied()
    .find(|v| *v == value)
    .unwrap_or("unknown")
}

fn normalize_occurrence(value: &str) -> &'static str {
    match value {
        "just_now" => "just_now",
        "within_1h" => "within_1h",
        "today" => "today",
        "yesterday" => "yesterday",
        "older" => "older",
        "not_sure" => "not_sure",
        _ => "not_sure",
    }
}

fn normalize_environment(input: &PublicEnvironmentInput) -> PublicEnvironment {
    PublicEnvironment {
        work_mode: normalize_enum(&input.work_mode, &["local", "server", "cloud_api"]),
        speech_input_language: normalize_language(&input.speech_input_language),
        ai_enabled: input.ai_enabled,
        asr_provider: normalize_enum(&input.asr_provider, &["local", "server", "cloud"]),
        ai_provider: normalize_enum(&input.ai_provider, &["none", "server", "cloud"]),
        local_accelerator: normalize_enum(
            &input.local_accelerator,
            &["cpu", "cuda", "vulkan", "auto"],
        ),
    }
}

/// Instants an offset-less local timestamp can denote. During the repeated hour
/// when daylight saving time ends the same local time exists twice, so a
/// caller that filters by time must consider both occurrences.
#[derive(Clone, Copy)]
struct TimestampCandidates {
    first: chrono::DateTime<chrono::Local>,
    second: Option<chrono::DateTime<chrono::Local>>,
}

impl TimestampCandidates {
    /// Whether at least one occurrence is at or after `cutoff`. Comparing the
    /// first occurrence alone would still drop entries from the second
    /// occurrence of a repeated hour.
    fn any_at_or_after(self, cutoff: chrono::DateTime<chrono::Local>) -> bool {
        self.first >= cutoff || self.second.is_some_and(|second| second >= cutoff)
    }

    /// The occurrence closest to `now`, so an event from the second occurrence
    /// is not reported an hour older than it is.
    fn closest_to(self, now: chrono::DateTime<chrono::Local>) -> chrono::DateTime<chrono::Local> {
        match self.second {
            Some(second)
                if now.signed_duration_since(second).num_seconds().abs()
                    < now.signed_duration_since(self.first).num_seconds().abs() =>
            {
                second
            }
            _ => self.first,
        }
    }
}

fn parse_timestamp_candidates(value: &str) -> Option<TimestampCandidates> {
    for format in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%d %H:%M:%S"] {
        if let Ok(naive) = chrono::NaiveDateTime::parse_from_str(value, format) {
            return match naive.and_local_timezone(chrono::Local) {
                chrono::LocalResult::Single(local) => Some(TimestampCandidates {
                    first: local,
                    second: None,
                }),
                chrono::LocalResult::Ambiguous(first, second) => Some(TimestampCandidates {
                    first,
                    second: Some(second),
                }),
                chrono::LocalResult::None => None,
            };
        }
    }
    None
}

fn safe_category(module: &str) -> &'static str {
    let marker = module.to_ascii_lowercase();
    if marker.contains("asr") || marker.contains("speech") || marker.contains("transcrib") {
        "asr"
    } else if marker.contains("ai") || marker.contains("llm") || marker.contains("cleanup") {
        "ai"
    } else if marker.contains("network")
        || marker.contains("http")
        || marker.contains("provider")
        || marker.contains("server")
    {
        "network"
    } else if marker.contains("audio") || marker.contains("record") {
        "audio"
    } else if marker.contains("storage") || marker.contains("database") {
        "storage"
    } else if marker.contains("ui") || marker.contains("window") || marker.contains("overlay") {
        "ui"
    } else if marker.contains("system") || marker.contains("rust") {
        "system"
    } else {
        "unknown"
    }
}

fn stable_error_code(message: &str) -> Option<&'static str> {
    let text = message.to_ascii_lowercase();
    [
        ("timeout", "provider_timeout"),
        ("timed out", "provider_timeout"),
        ("unreachable", "provider_unreachable"),
        ("bad key", "provider_bad_key"),
        ("invalid api key", "provider_bad_key"),
        ("forbidden", "provider_forbidden"),
        ("rate limit", "provider_rate_limit"),
        ("insufficient_balance", "provider_insufficient_balance"),
        ("insufficient balance", "provider_insufficient_balance"),
        ("no model", "provider_no_model"),
        ("model not found", "provider_no_model"),
        ("connect failed", "connect_failed"),
        ("connection failed", "connect_failed"),
    ]
    .iter()
    .find_map(|(needle, code)| text.contains(needle).then_some(*code))
    .or_else(|| {
        (text.contains("provider") && (text.contains("failed") || text.contains("error")))
            .then_some("provider_failed")
    })
}

fn public_events_from_bytes(
    bytes: &[u8],
    occurrence: &str,
    now: chrono::DateTime<chrono::Local>,
) -> Vec<PublicEvent> {
    let cutoff = occurrence_cutoff(occurrence);
    let mut events = Vec::new();
    for raw_line in bytes.split(|byte| *byte == b'\n').take(MAX_LINES) {
        if raw_line.len() > MAX_LINE_BYTES {
            continue;
        }
        let Ok(line) = std::str::from_utf8(raw_line).map(|line| line.trim_end_matches('\r')) else {
            continue;
        };
        let Some((timestamps, severity, category, message)) = parse_public_line(line) else {
            continue;
        };
        if cutoff.is_some_and(|cutoff| !timestamps.any_at_or_after(cutoff)) {
            continue;
        }
        if events.len() >= MAX_EVENTS {
            break;
        }
        let timestamp = timestamps.closest_to(now);
        let age_minutes = now.signed_duration_since(timestamp).num_minutes().max(0) as u64;
        events.push(PublicEvent {
            age_minutes,
            severity,
            category,
            event_kind: "log_event",
            error_code: stable_error_code(message),
        });
    }
    events
}

fn parse_public_line(
    line: &str,
) -> Option<(TimestampCandidates, &'static str, &'static str, &str)> {
    let start = line.strip_prefix('[')?;
    let end = start.find(']')?;
    let timestamp = parse_timestamp_candidates(start[..end].trim_start_matches('[').trim())?;
    let rest = start[end + 1..].trim_start();
    let rest = rest.strip_prefix('[')?;
    let level_end = rest.find(']')?;
    let severity = match rest[..level_end].trim().to_ascii_lowercase().as_str() {
        "error" => "error",
        "warn" | "warning" => "warning",
        "info" => "info",
        _ => return None,
    };
    let rest = rest[level_end + 1..].trim_start();
    let rest = rest.strip_prefix('[')?;
    let module_end = rest.find(']')?;
    let category = safe_category(rest[..module_end].trim());
    if category == "unknown" {
        return None;
    }
    Some((timestamp, severity, category, rest[module_end + 1..].trim()))
}

fn read_public_events(occurrence: &str) -> (Vec<PublicEvent>, usize) {
    let mut events = Vec::new();
    let mut files_scanned = 0;
    let now = chrono::Local::now();
    for filename in ["sayit.log", "sayit.1.log", "sayit.2.log", "sayit.3.log"] {
        let path = log_dir().join(filename);
        if !path.exists() {
            continue;
        }
        files_scanned += 1;
        let Ok(mut file) = std::fs::File::open(path) else {
            continue;
        };
        if let Ok(metadata) = file.metadata() {
            if metadata.len() > MAX_LOG_BYTES as u64
                && file
                    .seek(std::io::SeekFrom::End(-(MAX_LOG_BYTES as i64)))
                    .is_err()
            {
                continue;
            }
        }
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take(MAX_LOG_BYTES as u64)
            .read_to_end(&mut bytes)
            .ok();
        events.extend(public_events_from_bytes(&bytes, occurrence, now));
        if events.len() >= MAX_EVENTS {
            events.truncate(MAX_EVENTS);
            break;
        }
    }
    (events, files_scanned)
}

fn write_json_entry<W: Write + Seek>(
    zip: &mut zip::ZipWriter<W>,
    name: &str,
    value: &impl Serialize,
    options: zip::write::FileOptions,
) -> Result<(), String> {
    zip.start_file(name, options).map_err(|e| e.to_string())?;
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_ARCHIVE_BYTES {
        return Err("Diagnostics entry exceeds size limit".to_string());
    }
    zip.write_all(&bytes).map_err(|e| e.to_string())
}

fn create_public_bundle_at(req: &PublicBundleRequest, zip_path: &Path) -> Result<(), String> {
    let occurrence = normalize_occurrence(&req.issue_occurrence);
    let environment = normalize_environment(&req.environment);
    let (events, files_scanned) = read_public_events(occurrence);
    let errors = events
        .iter()
        .filter(|event| event.severity == "error")
        .count();
    let warnings = events
        .iter()
        .filter(|event| event.severity == "warning")
        .count();
    let manifest = serde_json::json!({ "formatVersion": 1, "appVersion": env!("CARGO_PKG_VERSION"), "platform": std::env::consts::OS });
    let summary = serde_json::json!({ "occurrenceCategory": occurrence, "filesScanned": files_scanned, "eventCount": events.len(), "errorCount": errors, "warningCount": warnings });
    let file = std::fs::File::create(zip_path).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipWriter::new(file);
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    if let Err(error) = (|| {
        write_json_entry(&mut zip, "manifest.json", &manifest, options)?;
        write_json_entry(&mut zip, "environment.json", &environment, options)?;
        write_json_entry(&mut zip, "summary.json", &summary, options)?;
        write_json_entry(&mut zip, "events.json", &events, options)?;
        zip.finish().map_err(|e| e.to_string())
    })() {
        let _ = std::fs::remove_file(zip_path);
        return Err(error);
    }
    Ok(())
}

fn diagnostics_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.sayit.app")
        .join("diagnostics")
}

#[tauri::command]
pub fn create_public_diagnostics_bundle(data: Value) -> Result<String, String> {
    let req: PublicBundleRequest = serde_json::from_value(data).map_err(|e| e.to_string())?;
    let dir = diagnostics_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!(
        "diagnostics-{}.zip",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    );
    let path = dir.join(name);
    create_public_bundle_at(&req, &path)?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn copy_diagnostics_zip(source: String, destination: String) -> Result<(), String> {
    copy_diagnostics_zip_in(&source, &destination, &diagnostics_dir())
}

/// The support archive is always a `.zip` created by
/// `create_public_diagnostics_bundle` directly in the diagnostics directory.
/// Copying and reading must not accept any other path: the source path arrives
/// from the frontend, and the save operation deletes the source after copying.
fn diagnostics_zip_in_dir(path: &str, dir: &Path) -> Option<PathBuf> {
    let path = Path::new(path);
    if !crate::path_guard::has_extension(path, &["zip"]) {
        return None;
    }
    if !source_matches_diagnostics_root(path, dir) {
        return None;
    }
    crate::path_guard::existing_file_in_dir(path, dir)
}

/// Whether `path` may name an archive in `dir` without resolving an unrelated
/// location first.
///
/// A local diagnostics directory only accepts local absolute paths, so a
/// crafted UNC or device path cannot trigger a network or device lookup just by
/// being canonicalized. When the directory itself is not local, only a path
/// inside that same root is accepted: the archive was created by the app
/// there, while another share would still be an arbitrary lookup.
fn source_matches_diagnostics_root(path: &Path, dir: &Path) -> bool {
    if crate::path_guard::is_local_absolute_path(dir) {
        crate::path_guard::is_local_absolute_path(path)
    } else {
        path.starts_with(dir)
    }
}

fn copy_diagnostics_zip_in(
    source: &str,
    destination: &str,
    diagnostics_dir: &Path,
) -> Result<(), String> {
    if !crate::path_guard::has_extension(Path::new(destination), &["zip"]) {
        return Err("The diagnostics file must be saved as a .zip".to_string());
    }
    let Some(src) = diagnostics_zip_in_dir(source, diagnostics_dir) else {
        return Err("The diagnostics file does not exist".to_string());
    };
    std::fs::copy(&src, destination)
        .map_err(|e| format!("Failed to copy diagnostics file: {}", e))?;
    let _ = std::fs::remove_file(&src);
    Ok(())
}

#[tauri::command]
pub fn read_log_file(log_type: String) -> Result<Option<String>, String> {
    let filename = match log_type.as_str() {
        "current" | "" | "frontend" | "ptt" => "sayit.log",
        "1" => "sayit.1.log",
        "2" => "sayit.2.log",
        "3" => "sayit.3.log",
        _ => "sayit.log",
    };
    let path = log_dir().join(filename);
    if !path.exists() {
        return Ok(None);
    }
    const MAX_READ: u64 = 200 * 1024;
    let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
    if size <= MAX_READ {
        return Ok(Some(
            String::from_utf8_lossy(&std::fs::read(path).map_err(|e| e.to_string())?).into_owned(),
        ));
    }
    use std::io::SeekFrom;
    let mut file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    file.seek(SeekFrom::End(-(MAX_READ as i64)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::with_capacity(MAX_READ as usize);
    file.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
    let mut content = String::from_utf8_lossy(&bytes).into_owned();
    if let Some(pos) = content.find('\n') {
        content = content[pos + 1..].to_string();
    }
    Ok(Some(format!("... (showing last ~200KB) ...\n{}", content)))
}

#[tauri::command]
pub fn open_log_folder() -> Result<(), String> {
    let dir = log_dir();
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    #[cfg(target_os = "windows")]
    std::process::Command::new("explorer")
        .arg(dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    #[cfg(target_os = "macos")]
    std::process::Command::new("open")
        .arg(dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    #[cfg(target_os = "linux")]
    std::process::Command::new("xdg-open")
        .arg(dir.to_string_lossy().to_string())
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_values_normalize_to_safe_enums() {
        assert_eq!(normalize_occurrence("evil"), "not_sure");
        assert_eq!(normalize_language("../../secret"), "unknown");
        assert_eq!(
            normalize_enum("https://api.example", &["local", "server"]),
            "unknown"
        );
    }

    #[test]
    fn public_parser_drops_malformed_non_utf8_and_oversized_lines() {
        let now = chrono::Local::now();
        let mut bytes = b"[2026-01-01 00:00:00] [error] [provider] timeout https://api.example/token C:\\Users\\Alice\\prompt\n".to_vec();
        bytes.extend_from_slice(&[0xff, b'\n']);
        bytes.extend(std::iter::repeat(b'x').take(MAX_LINE_BYTES + 1));
        bytes.push(b'\n');
        bytes.extend_from_slice(b"not a log line\n");
        let events = public_events_from_bytes(&bytes, "older", now);
        assert_eq!(events.len(), 1);
        let json = serde_json::to_string(&events).unwrap();
        assert!(!json.contains("api.example"));
        assert!(!json.contains("Alice"));
        assert!(json.contains("provider_timeout"));
    }

    #[test]
    fn public_parser_drops_unrecognized_sources() {
        let now = chrono::Local::now();
        let line = format!(
            "[{}] [INFO] [custom-private-source] timeout",
            now.format("%Y-%m-%d %H:%M:%S")
        );

        assert!(public_events_from_bytes(line.as_bytes(), "older", now).is_empty());
    }

    #[test]
    fn known_failures_emit_only_stable_code_and_category() {
        let now = chrono::Local::now();
        let line = format!(
            "[{}] [ERROR] [provider] invalid api key",
            now.format("%Y-%m-%d %H:%M:%S")
        );
        let events = public_events_from_bytes(line.as_bytes(), "older", now);
        assert_eq!(events.len(), 1);
        let value = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(value["category"], "network");
        assert_eq!(value["errorCode"], "provider_bad_key");
        assert_eq!(value.as_object().unwrap().len(), 5);
    }

    #[test]
    fn insufficient_balance_emits_stable_code() {
        let now = chrono::Local::now();
        let line = format!(
            "[{}] [ERROR] [provider] openrouter_transcribe http_status FAILED code=provider_insufficient_balance OpenRouter transcription request returned HTTP status 402",
            now.format("%Y-%m-%d %H:%M:%S")
        );
        let events = public_events_from_bytes(line.as_bytes(), "older", now);
        assert_eq!(events.len(), 1);
        let value = serde_json::to_value(&events[0]).unwrap();
        assert_eq!(value["category"], "network");
        assert_eq!(value["errorCode"], "provider_insufficient_balance");
        assert_eq!(value.as_object().unwrap().len(), 5);
    }

    #[test]
    fn public_events_are_bounded() {
        let now = chrono::Local::now();
        let line = format!(
            "[{}] [INFO] [system] event\n",
            now.format("%Y-%m-%d %H:%M:%S")
        );
        let input = line.repeat(MAX_LINES + 100);
        assert_eq!(
            public_events_from_bytes(input.as_bytes(), "older", now).len(),
            MAX_EVENTS
        );
    }

    #[test]
    fn ambiguous_local_timestamps_are_kept() {
        // Zones without daylight saving time (for example UTC CI) have no
        // ambiguous local time, so the check has nothing to exercise there.
        let Some(naive) = find_ambiguous_local_time() else {
            return;
        };
        let text = naive.format("%Y-%m-%d %H:%M:%S").to_string();
        let candidates =
            parse_timestamp_candidates(&text).expect("an ambiguous local timestamp must parse");
        let second = candidates
            .second
            .expect("the ambiguous timestamp must keep its second occurrence");

        assert_eq!(
            Some(candidates.first),
            naive.and_local_timezone(chrono::Local).earliest(),
            "an ambiguous local timestamp must resolve to its first occurrence instead of being dropped"
        );
        assert_eq!(
            Some(second),
            naive.and_local_timezone(chrono::Local).latest(),
            "the second occurrence of a repeated hour must be kept as well"
        );
        assert!(
            candidates.any_at_or_after(second),
            "a cutoff equal to the second occurrence must keep the entry"
        );
        assert_eq!(
            candidates.closest_to(second),
            second,
            "an event reported at the second occurrence must use that occurrence"
        );
    }

    #[test]
    fn repeated_hour_occurrences_are_both_considered() {
        // Deterministic counterpart to the timezone-dependent check above:
        // machines and CI without daylight saving time never reach it.
        let first = chrono::Local::now();
        let second = first + chrono::Duration::hours(1);
        let candidates = TimestampCandidates {
            first,
            second: Some(second),
        };

        assert!(
            candidates.any_at_or_after(second),
            "a cutoff equal to the second occurrence must keep the entry"
        );
        assert!(
            !candidates.any_at_or_after(second + chrono::Duration::minutes(1)),
            "a cutoff after both occurrences must not keep the entry"
        );
        assert_eq!(
            candidates.closest_to(second),
            second,
            "the occurrence closest to now must be used for the reported age"
        );
    }

    fn find_ambiguous_local_time() -> Option<chrono::NaiveDateTime> {
        let start = chrono::NaiveDate::from_ymd_opt(2024, 1, 1)?.and_hms_opt(0, 0, 0)?;
        (0..(366 * 24 * 4)).find_map(|step| {
            let naive = start + chrono::Duration::minutes(step * 15);
            matches!(
                naive.and_local_timezone(chrono::Local),
                chrono::LocalResult::Ambiguous(_, _)
            )
            .then_some(naive)
        })
    }

    #[test]
    fn archive_has_exactly_four_safe_entries() {
        let temp = std::env::temp_dir().join(format!(
            "sayit-diagnostics-test-{}.zip",
            uuid::Uuid::new_v4()
        ));
        let request: PublicBundleRequest = serde_json::from_value(serde_json::json!({
            "issueOccurrence": "not_sure",
            "environment": {
                "workMode": "malicious-mode",
                "speechInputLanguage": "../../secret",
                "aiEnabled": true,
                "asrProvider": "unknown-provider",
                "aiProvider": "server",
                "localAccelerator": "C:\\Users\\Alice\\models"
            }
        }))
        .unwrap();
        create_public_bundle_at(&request, &temp).unwrap();
        let file = std::fs::File::open(&temp).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut names = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect::<Vec<_>>();
        names.sort();
        assert_eq!(
            names,
            vec![
                "environment.json",
                "events.json",
                "manifest.json",
                "summary.json"
            ]
        );
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            let mut content = String::new();
            entry.read_to_string(&mut content).unwrap();
            assert!(!content.contains("Alice"));
            assert!(!content.contains("secret"));
            assert!(!content.contains("models"));
            assert!(!content.contains("http"));
        }
        let _ = std::fs::remove_file(temp);
    }

    fn copy_temp_root() -> PathBuf {
        std::env::temp_dir().join(format!("sayit-diagnostics-copy-{}", uuid::Uuid::new_v4()))
    }

    #[test]
    fn copy_diagnostics_rejects_a_source_outside_the_diagnostics_directory() {
        let root = copy_temp_root();
        let diagnostics = root.join("diagnostics");
        std::fs::create_dir_all(&diagnostics).unwrap();
        let source = diagnostics.join("..").join("secret.zip");
        let destination = root.join("saved.zip");
        std::fs::write(&source, b"private").unwrap();

        let result = copy_diagnostics_zip_in(
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
            &diagnostics,
        );
        let copied = destination.exists();
        let source_survived = source.exists();

        let _ = std::fs::remove_dir_all(&root);

        assert!(
            result.is_err(),
            "a source outside the diagnostics directory must be rejected"
        );
        assert!(!copied, "an arbitrary file was copied to the destination");
        assert!(source_survived, "the arbitrary source file was deleted");
    }

    #[test]
    fn copy_diagnostics_rejects_a_non_zip_destination() {
        let root = copy_temp_root();
        let diagnostics = root.join("diagnostics");
        std::fs::create_dir_all(&diagnostics).unwrap();
        let source = diagnostics.join("archive.zip");
        let destination = root.join("saved.bat");
        std::fs::write(&source, b"archive").unwrap();

        let result = copy_diagnostics_zip_in(
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
            &diagnostics,
        );
        let copied = destination.exists();
        let source_survived = source.exists();

        let _ = std::fs::remove_dir_all(&root);

        assert!(result.is_err(), "a non-zip destination must be rejected");
        assert!(
            !copied,
            "the diagnostics archive was written with a non-zip extension"
        );
        assert!(
            source_survived,
            "the diagnostics archive was deleted on a rejected destination"
        );
    }

    #[test]
    fn copy_diagnostics_saves_an_archive_created_in_the_diagnostics_directory() {
        let root = copy_temp_root();
        let diagnostics = root.join("diagnostics");
        std::fs::create_dir_all(&diagnostics).unwrap();
        let source = diagnostics.join("archive.zip");
        let destination = root.join("saved.zip");
        std::fs::write(&source, b"archive").unwrap();

        copy_diagnostics_zip_in(
            &source.to_string_lossy(),
            &destination.to_string_lossy(),
            &diagnostics,
        )
        .unwrap();
        let copied = std::fs::read(&destination).unwrap();
        let source_deleted = !source.exists();

        let _ = std::fs::remove_dir_all(&root);

        assert_eq!(copied, b"archive");
        assert!(
            source_deleted,
            "the temporary diagnostics archive must be removed after saving"
        );
    }

    #[test]
    fn diagnostics_source_must_be_a_zip_directly_in_the_directory() {
        let root = copy_temp_root();
        let diagnostics = root.join("diagnostics");
        let nested = diagnostics.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let nested_zip = nested.join("archive.zip");
        std::fs::write(&nested_zip, b"archive").unwrap();

        let nested_rejected =
            diagnostics_zip_in_dir(&nested_zip.to_string_lossy(), &diagnostics).is_none();
        let network_rejected =
            diagnostics_zip_in_dir(r"\\server\share\archive.zip", &diagnostics).is_none();
        let wrong_extension_rejected = diagnostics_zip_in_dir(
            &diagnostics.join("archive.txt").to_string_lossy(),
            &diagnostics,
        )
        .is_none();
        let missing_rejected = diagnostics_zip_in_dir(
            &diagnostics.join("missing.zip").to_string_lossy(),
            &diagnostics,
        )
        .is_none();

        let _ = std::fs::remove_dir_all(&root);

        assert!(nested_rejected, "a nested archive must be rejected");
        assert!(network_rejected, "a network archive path must be rejected");
        assert!(
            wrong_extension_rejected,
            "a non-zip source must be rejected"
        );
        assert!(missing_rejected, "a missing archive must be rejected");
    }

    #[test]
    fn diagnostics_root_accepts_only_paths_of_its_own_class() {
        let local_root = Path::new(r"C:\Users\alina\AppData\Local\com.sayit.app\diagnostics");
        let local_source = local_root.join("archive.zip");
        let redirected_root =
            Path::new(r"\\server\profiles\alina\AppData\Local\com.sayit.app\diagnostics");
        let redirected_source = redirected_root.join("archive.zip");
        let fallback_root = Path::new(".").join("com.sayit.app").join("diagnostics");
        let fallback_source = fallback_root.join("archive.zip");
        let other_share = Path::new(r"\\elsewhere\share\archive.zip");

        assert!(
            source_matches_diagnostics_root(&local_source, local_root),
            "a local archive in the local diagnostics root must be accepted"
        );
        assert!(
            !source_matches_diagnostics_root(other_share, local_root),
            "a network path must not be resolved when the root is local"
        );
        assert!(
            source_matches_diagnostics_root(&redirected_source, redirected_root),
            "an archive created under a redirected root must be accepted"
        );
        assert!(
            !source_matches_diagnostics_root(other_share, redirected_root),
            "an unrelated share must not be accepted under a redirected root"
        );
        assert!(
            source_matches_diagnostics_root(&fallback_source, &fallback_root),
            "the relative fallback root must keep accepting its own archive"
        );
    }
}

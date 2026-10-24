// Backup / restore: export and import of configuration (JSON) and of all data
// (zip, audio included).
//
// Design notes:
// - Import goes through the active database's normal write path (app_settings
//   upsert + whole-table replacement of collections); it does not replace the
//   sqlite file and involves no file locks. The frontend restarts the app after
//   the import so in-memory state reloads.
// - The semantics are "overwrite": collections are replaced wholesale;
//   app_settings are overwritten key by key (keys absent from the file stay).
// - "Config" excludes the usage statistics, so importing it never overwrites
//   local counts; every full backup carries the `usage` section instead.
// - On a full import the history records' audioFilePath values are absolute
//   paths from the old machine; they are rewritten to the same file names under
//   the local audio directory.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::commands::file_transcription;
use crate::storage::{BUILTIN_PROMPT_IDS, Storage, parse_usage_backup};

/// Plain configuration file format version; imports reject a file newer than
/// this. The selected-config file and the full-data archive have their own
/// version constants below.
const FORMAT_VERSION: i64 = 1;
/// Selected-configuration file format. Plain config files and full-data
/// archives keep their own separate version constants.
const SELECTED_CONFIG_FORMAT_VERSION: i64 = 2;
/// Full-data archive format. Version 2 adds the optional `legacyProfileChars`
/// value on usage rows; version-1 archives stay readable.
const FULL_FORMAT_VERSION: i64 = 2;
const MAX_HOTWORDS: usize = 1000;
/// app_settings keys that the config-only export/import skips: usage statistics
/// are usage data, not configuration. Both are legacy counter keys that old
/// config files may still carry; usage now lives in `usage_events`.
const CONFIG_EXCLUDE: &[&str] = &["stats", "userStats"];
/// app_settings keys that hold local identity or internal bookkeeping rather
/// than user-visible preferences. They are never written into a backup and never
/// applied from one: a foreign archive must not clone the local device identity,
/// replay another machine's first-run autostart migration, or move its WebDAV
/// scheduler state here.
///
/// Everything else is a user setting and belongs to a full backup, including
/// the update-check preference, microphone/system-audio selections, local model
/// folder and compute backend, and absolute output folders: restoring a backup
/// on the same machine must reproduce the saved configuration. The actual
/// autostart registration lives in the OS, not in `app_settings`, so it is
/// outside both the backup and this list.
const LOCAL_STATE_KEYS: &[&str] = &[
    "deviceId",
    "autoLaunchInitialized",
    "autoLaunchArgsMigrated",
    "webdav.lastResult",
    "webdav.lastBackupAt",
    "webdav.lastAttemptAt",
];

/// Everything a configuration export/import must skip: the legacy usage
/// counters plus the local-state keys. A full backup skips only
/// [`LOCAL_STATE_KEYS`] and carries usage in its own section.
fn config_exclusions() -> Vec<&'static str> {
    CONFIG_EXCLUDE
        .iter()
        .copied()
        .chain(LOCAL_STATE_KEYS.iter().copied())
        .collect()
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExportSelection {
    mode: String,
    #[serde(default)]
    hotword_group_ids: Vec<String>,
    #[serde(default)]
    include_text_replacements: bool,
    #[serde(default)]
    text_replacements: Option<Vec<Value>>,
    #[serde(default)]
    prompt_preset_ids: Vec<String>,
}

/// What a full backup carries besides the configuration.
///
/// Neither field gets a serde default: the caller must state the scope
/// explicitly. Defaulting them is a trap — an omitted argument would silently
/// pack "everything", and an archive with audio can be several gigabytes, which
/// in the automatic-backup path means quietly uploading gigabytes every time.
/// Failing deserialization with a visible error is preferable.
#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupScope {
    pub include_history: bool,
    pub include_audio: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportSectionPreview {
    kind: String,
    total: usize,
    added: usize,
    updated: usize,
    skipped: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportWarning {
    code: String,
    current: Option<usize>,
    limit: Option<usize>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportPreview {
    scope: String,
    format_version: i64,
    import_token: String,
    sections: Vec<ConfigImportSectionPreview>,
    warnings: Vec<ConfigImportWarning>,
    requires_restart: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportResult {
    changed_sections: Vec<String>,
    added: usize,
    updated: usize,
    skipped: usize,
    requires_restart: bool,
}

struct SelectedImportPlan {
    app_settings: Map<String, Value>,
    prompt_presets: Option<Vec<Value>>,
    sections: Vec<ConfigImportSectionPreview>,
    warnings: Vec<ConfigImportWarning>,
    added: usize,
    updated: usize,
    skipped: usize,
}

fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn audio_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("com.sayit.app")
        .join("audio")
}

fn backup_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::document_dir)
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join("com.sayit.app")
        })
        .join("SayIt Backups")
}

fn timestamped_backup_path(prefix: &str, extension: &str) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y-%m-%d_%H-%M-%S-%3f");
    backup_dir().join(format!("{}-{}.{}", prefix, timestamp, extension))
}

/// Returns the file-name part of a path. Both separators are accepted so a
/// backup made on another platform still yields the recording name.
fn basename(path: &str) -> String {
    path.rsplit(|c| c == '/' || c == '\\')
        .next()
        .unwrap_or(path)
        .to_string()
}

const BACKUP_ENTRY_NAME: &str = "backup.json";
const AUDIO_ENTRY_PREFIX: &str = "audio/";

/// Device names Windows reserves in every directory. `create_new` on one of
/// them opens a device instead of a file, so a backup must never publish such a
/// name.
const WINDOWS_RESERVED_FILE_STEMS: &[&str] = &[
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9", "conin$",
    "conout$",
];

/// Validates one flat recording name taken from a backup.
///
/// A backup recording is stored as `audio/<name>.wav`, so `<name>` must be a
/// single plain `.wav` segment. This is deliberately stricter than
/// [`basename`]: `basename` would silently flatten `../x.wav` or `C:x.wav` and
/// still write the result, while a hostile name has to be rejected before any
/// file is created. The returned name is safe to join under the audio directory.
fn validate_audio_file_name(name: &str) -> Result<&str, String> {
    if name.is_empty() {
        return Err("the name is empty".to_string());
    }
    if name == "." || name == ".." {
        return Err("the name is not a file name".to_string());
    }
    if name.contains('/') || name.contains('\\') {
        return Err("the name contains a path separator".to_string());
    }
    if name.contains(':') {
        return Err("the name contains a drive or stream separator".to_string());
    }
    if name
        .chars()
        .any(|c| c.is_control() || matches!(c, '<' | '>' | '"' | '|' | '?' | '*'))
    {
        return Err("the name contains characters Windows does not allow".to_string());
    }
    if name.ends_with('.') || name.ends_with(' ') {
        return Err("the name ends with a dot or a space".to_string());
    }
    if !name.to_ascii_lowercase().ends_with(".wav") {
        return Err("only .wav audio files are supported".to_string());
    }
    let stem = name
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if WINDOWS_RESERVED_FILE_STEMS.contains(&stem.as_str()) {
        return Err("the name is reserved by Windows".to_string());
    }
    Ok(name)
}

/// Checks one archive member before the restore writes anything.
///
/// A SayIt full backup contains exactly `backup.json` and flat
/// `audio/<name>.wav` members (the optional `audio/` folder entry is tolerated).
/// Anything else — an executable, a nested or traversal path, a drive-relative
/// name, an absolute path — is rejected as a whole archive instead of being
/// ignored or flattened.
fn validate_archive_entry(name: &str, is_dir: bool) -> Result<Option<&str>, String> {
    if name == BACKUP_ENTRY_NAME {
        if is_dir {
            return Err("backup.json must be a file, not a folder".to_string());
        }
        return Ok(None);
    }
    if name == AUDIO_ENTRY_PREFIX {
        if !is_dir {
            return Err("audio/ must be a folder, not a file".to_string());
        }
        return Ok(None);
    }
    let Some(file_name) = name.strip_prefix(AUDIO_ENTRY_PREFIX) else {
        return Err(format!("The backup contains an unexpected entry: {name}"));
    };
    if is_dir {
        return Err(format!("The backup contains an unexpected folder: {name}"));
    }
    validate_audio_file_name(file_name)
        .map(Some)
        .map_err(|reason| format!("The backup audio entry '{name}' is not allowed: {reason}"))
}

/// Validates every member name up front, so a rejected archive leaves no files
/// and no database changes behind. Duplicate names are rejected too: a zip may
/// legally carry them, and silently keeping the first or the last one would
/// make the restore depend on the reader's ordering.
fn validate_archive_entries(archive: &mut zip::ZipArchive<fs::File>) -> Result<(), String> {
    let mut seen = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = entry.name().to_string();
        // Windows matches file names case-insensitively using Unicode case
        // folding, not ASCII. An ASCII-only key would let `Ä.wav` and `ä.wav`
        // both pass and then silently alias to one file on disk.
        if !seen.insert(name.to_uppercase()) {
            return Err(format!("The backup contains duplicate entries: {name}"));
        }
        let _ = validate_archive_entry(&name, entry.is_dir())?;
    }
    Ok(())
}

fn build_config_value(storage: &Storage) -> Result<Value, String> {
    let app_settings = storage
        .export_app_settings(&config_exclusions())
        .map_err(|error| format!("Failed to export app settings: {}", error))?;

    Ok(json!({
        "kind": "config",
        "formatVersion": FORMAT_VERSION,
        "appVersion": app_version(),
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "appSettings": app_settings,
        "promptPresets": storage
            .export_collection("promptPresets")
            .map_err(|error| format!("Failed to export prompt presets: {}", error))?,
        "appPromptRules": storage
            .export_collection("appPromptRules")
            .map_err(|error| format!("Failed to export app prompt rules: {}", error))?,
    }))
}

fn normalized_strings(value: Option<&Value>) -> Vec<String> {
    let mut seen = HashSet::new();
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .filter(|item| seen.insert((*item).to_string()))
        .map(ToString::to_string)
        .collect()
}

fn build_selected_config_value(
    storage: &Storage,
    selection: &ConfigExportSelection,
) -> Result<Value, String> {
    let selected_hotword_ids: HashSet<&str> = selection
        .hotword_group_ids
        .iter()
        .map(String::as_str)
        .collect();
    let selected_preset_ids: HashSet<&str> = selection
        .prompt_preset_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut items = Map::new();

    if !selected_hotword_ids.is_empty() {
        let themes_value = storage.get("customHotwordThemes", None);
        let active_value = storage.get("customThemeActive", None);
        let active_map = active_value.as_object();
        let groups = themes_value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_object)
            .filter(|theme| {
                theme
                    .get("id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| selected_hotword_ids.contains(id))
            })
            .filter_map(|theme| {
                let id = theme.get("id")?.as_str()?;
                let name = theme.get("name")?.as_str()?.trim();
                if name.is_empty() {
                    return None;
                }
                Some(json!({
                    "name": name,
                    "words": normalized_strings(theme.get("words")),
                    "enabled": active_map
                        .and_then(|map| map.get(id))
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                }))
            })
            .collect::<Vec<_>>();
        items.insert("hotwordGroups".to_string(), Value::Array(groups));
    }

    if selection.include_text_replacements {
        let source_rules = selection.text_replacements.clone().unwrap_or_else(|| {
            storage
                .get("textReplacements", None)
                .as_array()
                .cloned()
                .unwrap_or_default()
        });
        let rules = source_rules
            .into_iter()
            .filter_map(|rule| {
                let obj = rule.as_object()?;
                let from = obj.get("from")?.as_str()?.trim();
                if from.is_empty() {
                    return None;
                }
                Some(json!({
                    "from": from,
                    "to": obj.get("to").and_then(Value::as_str).unwrap_or(""),
                    "enabled": obj.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                }))
            })
            .collect::<Vec<_>>();
        items.insert("textReplacements".to_string(), Value::Array(rules));
    }

    if !selected_preset_ids.is_empty() {
        let presets = storage
            .export_collection("promptPresets")
            .map_err(|error| format!("Failed to export prompt presets: {}", error))?
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|preset| {
                let obj = preset.as_object()?;
                let id = obj.get("id")?.as_str()?;
                if !selected_preset_ids.contains(id) || BUILTIN_PROMPT_IDS.contains(&id) {
                    return None;
                }
                let name = obj.get("name")?.as_str()?.trim();
                let system_prompt = obj.get("systemPrompt")?.as_str()?.trim();
                if name.is_empty() || system_prompt.is_empty() {
                    return None;
                }
                Some(json!({ "name": name, "systemPrompt": system_prompt }))
            })
            .collect::<Vec<_>>();
        items.insert("promptPresets".to_string(), Value::Array(presets));
    }

    if items.is_empty() {
        return Err("Select at least one configuration item to export".to_string());
    }

    Ok(json!({
        "kind": "config",
        "formatVersion": SELECTED_CONFIG_FORMAT_VERSION,
        "scope": "selected",
        "appVersion": app_version(),
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "items": Value::Object(items),
    }))
}

/// Assembles `backup.json`.
///
/// Without history the field is **omitted entirely** (not written as an empty
/// array): `import_full` uses `if let Some(...)` for missing sections, so an
/// absent field is skipped and the local history is kept; an empty array would
/// wipe the local history table instead. The config-only profile can be safely
/// restored only because of this difference.
fn build_full_value(storage: &Storage, scope: BackupScope) -> Result<Value, String> {
    let usage = storage
        .usage_backup()
        .map_err(|e| format!("Failed to read usage statistics: {}", e))?;
    let usage = serde_json::to_value(&usage)
        .map_err(|e| format!("Failed to serialize usage statistics: {}", e))?;
    let mut payload = json!({
        "kind": "full",
        "formatVersion": FULL_FORMAT_VERSION,
        "appVersion": app_version(),
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        // The archive reports what it contains, for the pre-restore preview and
        // for diagnosing "why is my history missing after a restore".
        "scope": {
            "includeHistory": scope.include_history,
            "includeAudio": scope.include_audio,
        },
        "appSettings": storage
            .export_app_settings(LOCAL_STATE_KEYS)
            .map_err(|error| format!("Failed to export app settings: {}", error))?,
        "promptPresets": storage
            .export_collection("promptPresets")
            .map_err(|error| format!("Failed to export prompt presets: {}", error))?,
        "appPromptRules": storage
            .export_collection("appPromptRules")
            .map_err(|error| format!("Failed to export app prompt rules: {}", error))?,
        // Usage travels with every full backup, the config-only WebDAV profile
        // included, the same way the legacy `stats` key travelled inside
        // appSettings.
        "usage": usage,
    });

    if scope.include_history {
        let history = storage
            .export_collection("history")
            .map_err(|error| format!("Failed to export history: {}", error))?;
        let manual_corrections = storage
            .export_collection("manualCorrections")
            .map_err(|error| format!("Failed to export manual corrections: {}", error))?;
        let feedback_queue = storage
            .export_collection("feedbackQueue")
            .map_err(|error| format!("Failed to export feedback queue: {}", error))?;
        if let Some(object) = payload.as_object_mut() {
            object.insert("history".to_string(), history);
            object.insert("manualCorrections".to_string(), manual_corrections);
            object.insert("feedbackQueue".to_string(), feedback_queue);
        }
    }

    Ok(payload)
}

fn check_kind_and_version(
    data: &Value,
    expected_kind: &str,
    max_version: i64,
) -> Result<i64, String> {
    let kind = data.get("kind").and_then(Value::as_str).unwrap_or("");
    if kind != expected_kind {
        return Err(format!(
            "This is not a valid SayIt {} file",
            if expected_kind == "full" {
                "full-data backup"
            } else {
                "configuration"
            }
        ));
    }
    // A missing version is not a legacy version: every export this app ever
    // wrote carries one. Treating it as zero would accept a hand-made JSON that
    // merely declares the right `kind`.
    let version = data
        .get("formatVersion")
        .and_then(Value::as_i64)
        .ok_or_else(|| "This file has no valid formatVersion and cannot be imported".to_string())?;
    if version < 1 {
        return Err(format!("The backup version ({}) is not supported", version));
    }
    if version > max_version {
        return Err(format!(
            "The backup version ({}) is newer than this app supports ({}). Update SayIt before importing it.",
            version, max_version
        ));
    }
    Ok(version)
}

fn is_selected_config(data: &Value) -> bool {
    data.get("scope").and_then(Value::as_str) == Some("selected")
        && data.get("formatVersion").and_then(Value::as_i64) == Some(SELECTED_CONFIG_FORMAT_VERSION)
}

fn array_section<'a>(data: &'a Value, key: &str) -> Option<&'a [Value]> {
    data.get(key).and_then(Value::as_array).map(Vec::as_slice)
}

/// Applies the full configuration part (settings, prompt presets, per-app
/// rules); both import profiles share it.
fn apply_config_part(
    storage: &Storage,
    data: &Value,
    settings_exclude: &[&str],
) -> Result<(), String> {
    let empty_settings = Map::new();
    let app_settings = data
        .get("appSettings")
        .and_then(Value::as_object)
        .unwrap_or(&empty_settings);
    let prompt_presets = array_section(data, "promptPresets");
    let app_prompt_rules = array_section(data, "appPromptRules");

    storage
        .apply_config_transaction(
            app_settings,
            settings_exclude,
            prompt_presets,
            app_prompt_rules,
        )
        .map_err(|error| format!("Failed to write configuration: {}", error))
}

/// Streams one archive audio entry into the local audio directory. Audio files
/// are named after their record id, so an existing file with the same name is
/// the same recording: it is kept untouched and reused.
fn publish_audio_file<R: Read>(
    adir: &Path,
    base: &str,
    entry: &mut R,
    created: &mut Vec<PathBuf>,
) -> Result<(), String> {
    let path = adir.join(base);
    let mut file = match OpenOptions::new().write(true).create_new(true).open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => return Ok(()),
        Err(error) => return Err(format!("Failed to create audio file {}: {}", base, error)),
    };
    // Recorded before writing so a partially written file is removed on failure too.
    created.push(path);
    std::io::copy(entry, &mut file)
        .map(|_| ())
        .map_err(|error| format!("Failed to write audio file {}: {}", base, error))
}

/// Rewrites one history record to the local audio directory.
///
/// The old machine's absolute path is reduced to its file name, which must be a
/// safe `.wav` name. A record whose path cannot be rewritten that way loses the
/// field entirely: keeping the original path would let a crafted backup point a
/// record at an arbitrary local file, and clearing history deletes whatever
/// path the record carries.
fn rewrite_audio_path(rec: &Value, adir: &Path) -> Value {
    let mut rec = rec.clone();
    if let Some(obj) = rec.as_object_mut() {
        if let Some(p) = obj
            .get("audioFilePath")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
        {
            let base = basename(&p);
            match validate_audio_file_name(&base) {
                Ok(base) => {
                    let new_path = adir.join(base);
                    obj.insert(
                        "audioFilePath".to_string(),
                        Value::String(new_path.to_string_lossy().to_string()),
                    );
                }
                Err(_) => {
                    obj.remove("audioFilePath");
                }
            }
        }
    }
    rec
}

/// Validates every `audioFilePath` in the archive's history before the restore
/// writes anything.
///
/// A real record stores the recording path of the machine that made the backup,
/// so absolute paths and plain file names are accepted. Traversal components and
/// names that are not safe `.wav` file names are rejected as a malformed
/// archive: silently dropping the field would make the import succeed while the
/// archive is still hostile.
fn validate_history_audio_paths(data: &Value) -> Result<(), String> {
    let Some(history) = data.get("history").and_then(Value::as_array) else {
        return Ok(());
    };
    for (index, record) in history.iter().enumerate() {
        let Some(object) = record.as_object() else {
            // The collection validation rejects non-object records later; keep
            // this pass focused on the audio path.
            continue;
        };
        match object.get("audioFilePath") {
            None | Some(Value::Null) => {}
            Some(Value::String(path)) => {
                if path
                    .split(|c| c == '/' || c == '\\')
                    .any(|part| part == "..")
                {
                    return Err(format!(
                        "History record {} has an audioFilePath with a parent-directory component",
                        index + 1
                    ));
                }
                let base = basename(path);
                validate_audio_file_name(&base).map_err(|reason| {
                    format!(
                        "History record {} has an invalid audioFilePath '{}': {}",
                        index + 1,
                        path,
                        reason
                    )
                })?;
            }
            Some(_) => {
                return Err(format!(
                    "History record {} has an invalid audioFilePath",
                    index + 1
                ));
            }
        }
    }
    Ok(())
}

fn next_import_id(prefix: &str, used_ids: &mut HashSet<String>, sequence: &mut usize) -> String {
    loop {
        let candidate = format!(
            "{}_{}_{}",
            prefix,
            chrono::Utc::now().timestamp_millis(),
            *sequence
        );
        *sequence += 1;
        if used_ids.insert(candidate.clone()) {
            return candidate;
        }
    }
}

fn unique_import_name(base: &str, used_names: &mut HashSet<String>) -> String {
    if used_names.insert(base.to_lowercase()) {
        return base.to_string();
    }
    let mut index = 1usize;
    loop {
        let candidate = if index == 1 {
            format!("{} (Imported)", base)
        } else {
            format!("{} (Imported {})", base, index)
        };
        if used_names.insert(candidate.to_lowercase()) {
            return candidate;
        }
        index += 1;
    }
}

fn build_selected_import_plan(
    storage: &Storage,
    data: &Value,
) -> Result<SelectedImportPlan, String> {
    let items = data
        .get("items")
        .and_then(Value::as_object)
        .ok_or_else(|| "The configuration file is missing items and may be damaged".to_string())?;
    let mut app_settings = Map::new();
    let mut prompt_presets = None;
    let mut sections = Vec::new();
    let mut warnings = Vec::new();
    let mut total_added = 0usize;
    let mut total_updated = 0usize;
    let mut total_skipped = 0usize;
    let mut sequence = 0usize;

    if let Some(group_value) = items.get("hotwordGroups") {
        let imported_groups = group_value
            .as_array()
            .ok_or_else(|| "Invalid hotword group format".to_string())?;
        let mut local_groups = storage
            .get("customHotwordThemes", None)
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut active_map = storage
            .get("customThemeActive", None)
            .as_object()
            .cloned()
            .unwrap_or_default();
        let mut used_ids = local_groups
            .iter()
            .filter_map(|group| group.get("id").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<HashSet<_>>();
        let mut added = 0usize;
        let mut updated = 0usize;
        let mut skipped = 0usize;

        for imported in imported_groups {
            let Some(obj) = imported.as_object() else {
                skipped += 1;
                continue;
            };
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if name.is_empty() {
                skipped += 1;
                continue;
            }
            let words = normalized_strings(obj.get("words"));
            let normalized_name = name.to_lowercase();
            let existing_index = local_groups.iter().position(|group| {
                group
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|current| current.trim().to_lowercase() == normalized_name)
            });

            if let Some(index) = existing_index {
                let existing_words = normalized_strings(local_groups[index].get("words"));
                let mut merged_words = existing_words.clone();
                let mut seen = existing_words.into_iter().collect::<HashSet<_>>();
                for word in words {
                    if seen.insert(word.clone()) {
                        merged_words.push(word);
                    }
                }
                if merged_words.len() == normalized_strings(local_groups[index].get("words")).len()
                {
                    skipped += 1;
                } else if let Some(local_obj) = local_groups[index].as_object_mut() {
                    local_obj.insert("words".to_string(), json!(merged_words));
                    updated += 1;
                }
            } else {
                let id = next_import_id("theme_import", &mut used_ids, &mut sequence);
                let enabled = obj.get("enabled").and_then(Value::as_bool).unwrap_or(true);
                local_groups.push(json!({ "id": id, "name": name, "words": words }));
                active_map.insert(id, Value::Bool(enabled));
                added += 1;
            }
        }

        let mut active_words = HashSet::new();
        for group in &local_groups {
            let Some(id) = group.get("id").and_then(Value::as_str) else {
                continue;
            };
            if active_map.get(id).and_then(Value::as_bool) != Some(true) {
                continue;
            }
            active_words.extend(normalized_strings(group.get("words")));
        }
        if active_words.len() > MAX_HOTWORDS {
            warnings.push(ConfigImportWarning {
                code: "hotwordLimit".to_string(),
                current: Some(active_words.len()),
                limit: Some(MAX_HOTWORDS),
            });
        }

        app_settings.insert(
            "customHotwordThemes".to_string(),
            Value::Array(local_groups),
        );
        app_settings.insert("customThemeActive".to_string(), Value::Object(active_map));
        sections.push(ConfigImportSectionPreview {
            kind: "hotwords".to_string(),
            total: imported_groups.len(),
            added,
            updated,
            skipped,
        });
        total_added += added;
        total_updated += updated;
        total_skipped += skipped;
    }

    if let Some(rules_value) = items.get("textReplacements") {
        let imported_rules = rules_value
            .as_array()
            .ok_or_else(|| "Invalid text replacement format".to_string())?;
        let mut local_rules = storage
            .get("textReplacements", None)
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut used_ids = local_rules
            .iter()
            .filter_map(|rule| rule.get("id").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<HashSet<_>>();
        let mut added = 0usize;
        let mut updated = 0usize;
        let mut skipped = 0usize;

        for imported in imported_rules {
            let Some(obj) = imported.as_object() else {
                skipped += 1;
                continue;
            };
            let from = obj
                .get("from")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if from.is_empty() {
                skipped += 1;
                continue;
            }
            let to = obj.get("to").and_then(Value::as_str).unwrap_or("");
            let existing_index = local_rules
                .iter()
                .position(|rule| rule.get("from").and_then(Value::as_str) == Some(from));

            if let Some(index) = existing_index {
                let current_to = local_rules[index]
                    .get("to")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if current_to == to {
                    skipped += 1;
                } else if let Some(local_obj) = local_rules[index].as_object_mut() {
                    local_obj.insert("to".to_string(), Value::String(to.to_string()));
                    updated += 1;
                }
            } else {
                let id = next_import_id("replacement_import", &mut used_ids, &mut sequence);
                local_rules.push(json!({
                    "id": id,
                    "from": from,
                    "to": to,
                    "enabled": obj.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                }));
                added += 1;
            }
        }

        app_settings.insert("textReplacements".to_string(), Value::Array(local_rules));
        sections.push(ConfigImportSectionPreview {
            kind: "textReplacements".to_string(),
            total: imported_rules.len(),
            added,
            updated,
            skipped,
        });
        total_added += added;
        total_updated += updated;
        total_skipped += skipped;
    }

    if let Some(presets_value) = items.get("promptPresets") {
        let imported_presets = presets_value
            .as_array()
            .ok_or_else(|| "Invalid prompt preset format".to_string())?;
        let mut local_presets = storage
            .export_collection("promptPresets")
            .map_err(|error| format!("Failed to export prompt presets: {}", error))?
            .as_array()
            .cloned()
            .unwrap_or_default();
        let mut used_ids = local_presets
            .iter()
            .filter_map(|preset| preset.get("id").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<HashSet<_>>();
        let mut used_names = local_presets
            .iter()
            .filter_map(|preset| preset.get("name").and_then(Value::as_str))
            .map(|name| name.trim().to_lowercase())
            .collect::<HashSet<_>>();
        let mut added = 0usize;
        let mut skipped = 0usize;

        for imported in imported_presets {
            let Some(obj) = imported.as_object() else {
                skipped += 1;
                continue;
            };
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let system_prompt = obj
                .get("systemPrompt")
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            if name.is_empty() || system_prompt.is_empty() {
                skipped += 1;
                continue;
            }
            let exact_duplicate = local_presets.iter().any(|preset| {
                preset
                    .get("name")
                    .and_then(Value::as_str)
                    .is_some_and(|current| current.trim().eq_ignore_ascii_case(name))
                    && preset.get("systemPrompt").and_then(Value::as_str) == Some(system_prompt)
            });
            if exact_duplicate {
                skipped += 1;
                continue;
            }
            let imported_name = unique_import_name(name, &mut used_names);
            let id = next_import_id("preset_import", &mut used_ids, &mut sequence);
            local_presets.push(json!({
                "id": id,
                "name": imported_name,
                "systemPrompt": system_prompt,
            }));
            added += 1;
        }

        prompt_presets = Some(local_presets);
        sections.push(ConfigImportSectionPreview {
            kind: "promptPresets".to_string(),
            total: imported_presets.len(),
            added,
            updated: 0,
            skipped,
        });
        total_added += added;
        total_skipped += skipped;
    }

    if sections.is_empty() {
        return Err("The configuration file contains nothing that can be imported".to_string());
    }

    Ok(SelectedImportPlan {
        app_settings,
        prompt_presets,
        sections,
        warnings,
        added: total_added,
        updated: total_updated,
        skipped: total_skipped,
    })
}

// ─── Export ───

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupExportProgress {
    status: String,
    phase: String,
    file_path: String,
    current_file: Option<String>,
    processed_files: u64,
    total_files: u64,
    processed_bytes: u64,
    total_bytes: u64,
    percent: f64,
    error: Option<String>,
}

struct AudioExportFile {
    path: PathBuf,
    name: String,
    size: u64,
}

fn emit_export_progress(app: &AppHandle, progress: BackupExportProgress) {
    let _ = app.emit("backup-export-progress", progress);
}

fn collect_audio_export_files(include_audio: bool) -> Vec<AudioExportFile> {
    let mut files = Vec::new();
    if !include_audio {
        return files;
    }
    let adir = audio_dir();
    if let Ok(entries) = fs::read_dir(adir) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(metadata) = entry.metadata() else {
                continue;
            };
            if !metadata.is_file() {
                continue;
            }
            let name = entry.file_name().to_string_lossy().to_string();
            // Only recordings belong in a backup. Without this filter a stray
            // executable in the audio folder would be packed and later accepted
            // by a restore, so export and import enforce the same rule.
            if validate_audio_file_name(&name).is_ok() {
                files.push(AudioExportFile {
                    path,
                    name,
                    size: metadata.len(),
                });
            }
        }
    }
    files.sort_by(|a, b| a.name.cmp(&b.name));
    files
}

fn audio_progress_percent(processed_bytes: u64, total_bytes: u64) -> f64 {
    if total_bytes == 0 {
        95.0
    } else {
        (5.0 + processed_bytes as f64 / total_bytes as f64 * 90.0).min(95.0)
    }
}

#[tauri::command]
pub fn get_backup_directory() -> Result<String, String> {
    let directory = backup_dir();
    fs::create_dir_all(&directory)
        .map_err(|e| format!("Failed to create backup directory: {}", e))?;
    Ok(directory.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn export_config(
    selection: ConfigExportSelection,
    storage: State<'_, Storage>,
) -> Result<String, String> {
    let out_path = timestamped_backup_path("sayit-config", "json");
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create backup directory: {}", e))?;
    }
    let payload = match selection.mode.as_str() {
        "full" => build_config_value(storage.inner())?,
        "selected" => build_selected_config_value(storage.inner(), &selection)?,
        _ => return Err("Unsupported configuration export mode".to_string()),
    };
    let content = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    fs::write(&out_path, content).map_err(|e| format!("Failed to write file: {}", e))?;
    let path = out_path.to_string_lossy().to_string();
    log::info!("Config backup exported to {}", path);
    Ok(path)
}

/// One progress frame while packing. The `phase` values match the frontend
/// `BackupExportProgress['phase']`.
pub struct ArchiveProgress<'a> {
    pub phase: &'static str,
    pub current_file: Option<&'a str>,
    pub processed_files: u64,
    pub total_files: u64,
    pub processed_bytes: u64,
    pub total_bytes: u64,
    pub percent: f64,
}

/// Packs the configuration (plus history and audio, as `scope` decides) into a
/// zip written to `output`.
///
/// The local "all data" export and the WebDAV backup share this one
/// implementation; they differ only in the destination and the progress event
/// name. WebDAV deliberately does not get its own packer: once the two code
/// paths diverge, the failure mode is "local export restores, cloud backup does
/// not", which only shows up when switching machines.
///
/// Writes a `.part` file first and renames it atomically; a failed pack removes
/// the temporary file — an interrupted half-written zip must not look like a
/// valid backup.
///
/// Counts (files / bytes) are reported through `on_progress` instead of being
/// returned: the caller needs the size of the finished zip itself (to compute
/// upload progress), which requires statting the output file.
pub fn write_backup_archive(
    storage: &Storage,
    scope: BackupScope,
    output: &Path,
    on_progress: &mut dyn FnMut(ArchiveProgress),
) -> Result<(), String> {
    let temp_path = PathBuf::from(format!("{}.part", output.to_string_lossy()));
    let audio_files = collect_audio_export_files(scope.include_audio);
    let total_files = audio_files.len() as u64;
    let total_bytes = audio_files.iter().map(|file| file.size).sum::<u64>();

    on_progress(ArchiveProgress {
        phase: "preparing",
        current_file: None,
        processed_files: 0,
        total_files,
        processed_bytes: 0,
        total_bytes,
        percent: 2.0,
    });

    let result = (|| -> Result<(), String> {
        if let Some(parent) = output.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create export directory: {}", e))?;
        }

        let payload = build_full_value(storage, scope)?;
        let json_str = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
        on_progress(ArchiveProgress {
            phase: "packingData",
            current_file: Some("backup.json"),
            processed_files: 0,
            total_files,
            processed_bytes: 0,
            total_bytes,
            percent: 5.0,
        });

        let file =
            fs::File::create(&temp_path).map_err(|e| format!("Failed to create file: {}", e))?;
        let mut zip = zip::ZipWriter::new(file);
        let text_opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        let audio_opts =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);

        zip.start_file("backup.json", text_opts)
            .map_err(|e| e.to_string())?;
        zip.write_all(json_str.as_bytes())
            .map_err(|e| e.to_string())?;

        let mut processed_bytes = 0u64;
        let mut processed_files = 0u64;
        let mut last_emit = Instant::now() - Duration::from_secs(1);
        let mut buffer = vec![0u8; 256 * 1024];

        for audio in &audio_files {
            zip.start_file(format!("audio/{}", audio.name), audio_opts)
                .map_err(|e| e.to_string())?;
            let mut source = fs::File::open(&audio.path)
                .map_err(|e| format!("Failed to read audio file {}: {}", audio.name, e))?;

            loop {
                let read = source
                    .read(&mut buffer)
                    .map_err(|e| format!("Failed to read audio file {}: {}", audio.name, e))?;
                if read == 0 {
                    break;
                }
                zip.write_all(&buffer[..read]).map_err(|e| e.to_string())?;
                processed_bytes += read as u64;

                if last_emit.elapsed() >= Duration::from_millis(150) {
                    on_progress(ArchiveProgress {
                        phase: "packingAudio",
                        current_file: Some(&audio.name),
                        processed_files,
                        total_files,
                        processed_bytes,
                        total_bytes,
                        percent: audio_progress_percent(processed_bytes, total_bytes),
                    });
                    last_emit = Instant::now();
                }
            }

            processed_files += 1;
            on_progress(ArchiveProgress {
                phase: "packingAudio",
                current_file: Some(&audio.name),
                processed_files,
                total_files,
                processed_bytes,
                total_bytes,
                percent: audio_progress_percent(processed_bytes, total_bytes),
            });
        }

        on_progress(ArchiveProgress {
            phase: "finalizing",
            current_file: None,
            processed_files,
            total_files,
            processed_bytes,
            total_bytes,
            percent: 98.0,
        });
        zip.finish().map_err(|e| e.to_string())?;

        if output.exists() {
            fs::remove_file(output)
                .map_err(|e| format!("Failed to replace the previous backup: {}", e))?;
        }
        fs::rename(&temp_path, output)
            .map_err(|e| format!("Failed to finalize the backup file: {}", e))?;
        Ok(())
    })();

    match result {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temp_path);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn export_full(
    app: AppHandle,
    scope: BackupScope,
    storage: State<'_, Storage>,
) -> Result<String, String> {
    let output = timestamped_backup_path("sayit-backup", "zip");
    let out_path = output.to_string_lossy().to_string();

    // The failure branch must also report the totals, so keep the latest values
    // in the callback: when write_backup_archive fails it only returns
    // Err(String), and the totals it computed internally are unavailable.
    let mut seen_totals = (0u64, 0u64);
    let export_result = {
        let progress_app = app.clone();
        let progress_path = out_path.clone();
        write_backup_archive(storage.inner(), scope, &output, &mut |progress| {
            seen_totals = (progress.total_files, progress.total_bytes);
            emit_export_progress(
                &progress_app,
                BackupExportProgress {
                    status: "running".to_string(),
                    phase: progress.phase.to_string(),
                    file_path: progress_path.clone(),
                    current_file: progress.current_file.map(ToString::to_string),
                    processed_files: progress.processed_files,
                    total_files: progress.total_files,
                    processed_bytes: progress.processed_bytes,
                    total_bytes: progress.total_bytes,
                    percent: progress.percent,
                    error: None,
                },
            );
        })
    };
    let (total_files, total_bytes) = seen_totals;

    match export_result {
        Ok(()) => {
            emit_export_progress(
                &app,
                BackupExportProgress {
                    status: "completed".to_string(),
                    phase: "completed".to_string(),
                    file_path: out_path.clone(),
                    current_file: None,
                    processed_files: total_files,
                    total_files,
                    processed_bytes: total_bytes,
                    total_bytes,
                    percent: 100.0,
                    error: None,
                },
            );
            log::info!(
                "Full backup exported to {} (history={} audio={})",
                out_path,
                scope.include_history,
                scope.include_audio
            );
            Ok(out_path)
        }
        Err(error) => {
            // The temporary file has already been removed by write_backup_archive.
            emit_export_progress(
                &app,
                BackupExportProgress {
                    status: "failed".to_string(),
                    phase: "failed".to_string(),
                    file_path: out_path,
                    current_file: None,
                    processed_files: 0,
                    total_files,
                    processed_bytes: 0,
                    total_bytes,
                    percent: 0.0,
                    error: Some(error.clone()),
                },
            );
            Err(error)
        }
    }
}

// ─── Import ───

fn content_fingerprint(content: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in content.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn read_config_file(in_path: &str) -> Result<(Value, String), String> {
    let content = fs::read_to_string(in_path).map_err(|e| format!("Failed to read file: {}", e))?;
    let data = serde_json::from_str(&content).map_err(|e| {
        format!(
            "Failed to parse the file; it may be damaged or have an invalid format: {}",
            e
        )
    })?;
    Ok((data, content_fingerprint(&content)))
}

fn config_import_token(
    storage: &Storage,
    data: &Value,
    file_fingerprint: &str,
) -> Result<String, String> {
    if !is_selected_config(data) {
        return Ok(file_fingerprint.to_string());
    }

    let context = json!({
        "file": file_fingerprint,
        "customHotwordThemes": storage.get("customHotwordThemes", None),
        "customThemeActive": storage.get("customThemeActive", None),
        "textReplacements": storage.get("textReplacements", None),
        "promptPresets": storage
            .export_collection("promptPresets")
            .map_err(|error| format!("Failed to export prompt presets: {}", error))?,
    });
    let serialized = serde_json::to_string(&context)
        .map_err(|error| format!("Failed to prepare import validation data: {}", error))?;
    Ok(content_fingerprint(&serialized))
}

fn validate_config_collection(key: &str, items: &[Value]) -> Result<(), String> {
    let mut ids = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let object = item
            .as_object()
            .ok_or_else(|| format!("Item {} in {} has an invalid format", index + 1, key))?;
        let id = object
            .get("id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| format!("Item {} in {} is missing id", index + 1, key))?;

        // Built-in prompt overrides for Chinese, English, and Ukrainian share promptPresets.
        // The same stable ID may occur once per language; backups without the language field are legacy Chinese entries.
        let unique_id = if key == "promptPresets" && BUILTIN_PROMPT_IDS.contains(&id) {
            let language = object
                .get("builtinPromptLanguage")
                .and_then(Value::as_str)
                .unwrap_or("zh-CN");
            if language != "zh-CN" && language != "en" && language != "uk" {
                return Err(format!(
                    "Item {} in {} has an invalid language",
                    index + 1,
                    key
                ));
            }
            format!("{}:{}", id, language)
        } else {
            id.to_string()
        };
        if !ids.insert(unique_id) {
            return Err(format!("{} contains a duplicate id: {}", key, id));
        }

        let required_fields: &[&str] = match key {
            "promptPresets" => &["name", "systemPrompt"],
            "appPromptRules" => &["appId", "name"],
            _ => &[],
        };
        for field in required_fields {
            let valid = object
                .get(*field)
                .and_then(Value::as_str)
                .is_some_and(|value| !value.trim().is_empty());
            if !valid {
                return Err(format!(
                    "Item {} in {} is missing {}",
                    index + 1,
                    key,
                    field
                ));
            }
        }
    }
    Ok(())
}

fn full_config_preview_sections(
    data: &Value,
    settings_exclude: &[&str],
) -> Result<Vec<ConfigImportSectionPreview>, String> {
    let mut sections = Vec::new();

    if let Some(value) = data.get("appSettings") {
        let settings = value
            .as_object()
            .ok_or_else(|| "appSettings has an invalid format".to_string())?;
        let importable = settings
            .keys()
            .filter(|key| !settings_exclude.contains(&key.as_str()))
            .count();
        if importable > 0 {
            sections.push(ConfigImportSectionPreview {
                kind: "appSettings".to_string(),
                total: importable,
                added: 0,
                updated: importable,
                skipped: 0,
            });
        }
    }

    for (key, kind) in [
        ("promptPresets", "promptPresets"),
        ("appPromptRules", "appPromptRules"),
    ] {
        if let Some(value) = data.get(key) {
            let items = value
                .as_array()
                .ok_or_else(|| format!("{} has an invalid format", key))?;
            validate_config_collection(key, items)?;
            sections.push(ConfigImportSectionPreview {
                kind: kind.to_string(),
                total: items.len(),
                added: 0,
                updated: items.len(),
                skipped: 0,
            });
        }
    }

    if sections.is_empty() {
        return Err("The file contains no complete configuration to import".to_string());
    }
    Ok(sections)
}

#[tauri::command]
pub async fn inspect_config_import(
    in_path: String,
    storage: State<'_, Storage>,
) -> Result<ConfigImportPreview, String> {
    let (data, file_fingerprint) = read_config_file(&in_path)?;
    let version = check_kind_and_version(&data, "config", SELECTED_CONFIG_FORMAT_VERSION)?;

    if is_selected_config(&data) {
        let plan = build_selected_import_plan(storage.inner(), &data)?;
        let import_token = config_import_token(storage.inner(), &data, &file_fingerprint)?;
        return Ok(ConfigImportPreview {
            scope: "selected".to_string(),
            format_version: version,
            import_token,
            sections: plan.sections,
            warnings: plan.warnings,
            requires_restart: true,
        });
    }

    if data.get("scope").is_some() || version > FORMAT_VERSION {
        return Err("Unsupported configuration scope or version".to_string());
    }

    let sections = full_config_preview_sections(&data, &config_exclusions())?;
    Ok(ConfigImportPreview {
        scope: "full".to_string(),
        format_version: version,
        import_token: file_fingerprint,
        sections,
        warnings: vec![ConfigImportWarning {
            code: "fullOverwrite".to_string(),
            current: None,
            limit: None,
        }],
        requires_restart: true,
    })
}

#[tauri::command]
pub async fn import_config(
    in_path: String,
    expected_import_token: String,
    storage: State<'_, Storage>,
) -> Result<ConfigImportResult, String> {
    let (data, file_fingerprint) = read_config_file(&in_path)?;
    let version = check_kind_and_version(&data, "config", SELECTED_CONFIG_FORMAT_VERSION)?;

    if is_selected_config(&data) {
        let actual_token = config_import_token(storage.inner(), &data, &file_fingerprint)?;
        if actual_token != expected_import_token {
            return Err("The configuration file or local settings changed; select the file again and reconfirm".to_string());
        }

        let plan = build_selected_import_plan(storage.inner(), &data)?;
        let changed_sections = plan
            .sections
            .iter()
            .filter(|section| section.added + section.updated > 0)
            .map(|section| section.kind.clone())
            .collect::<Vec<_>>();
        storage
            .apply_config_transaction(
                &plan.app_settings,
                &config_exclusions(),
                plan.prompt_presets.as_deref(),
                None,
            )
            .map_err(|error| format!("Failed to write configuration: {}", error))?;
        return Ok(ConfigImportResult {
            changed_sections,
            added: plan.added,
            updated: plan.updated,
            skipped: plan.skipped,
            requires_restart: true,
        });
    }

    if data.get("scope").is_some() || version > FORMAT_VERSION {
        return Err("Unsupported configuration scope or version".to_string());
    }
    full_config_preview_sections(&data, &config_exclusions())?;
    if file_fingerprint != expected_import_token {
        return Err("The configuration file changed; select it again and reconfirm".to_string());
    }

    // A full config import excludes the legacy counter keys and the
    // machine-local keys: it must not overwrite local counts, identity, or
    // device selections.
    apply_config_part(storage.inner(), &data, &config_exclusions())?;
    Ok(ConfigImportResult {
        changed_sections: vec!["fullConfig".to_string()],
        added: 0,
        updated: 1,
        skipped: 0,
        requires_restart: true,
    })
}

#[tauri::command]
pub async fn import_full(in_path: String, storage: State<'_, Storage>) -> Result<(), String> {
    apply_full_backup(storage.inner(), &in_path)
}

/// Applies a full backup zip. Shared by local import and WebDAV restore.
///
/// Tolerant of missing sections: a config-only backup (the WebDAV default
/// profile) has no `history` field, and then the **local history is kept**
/// rather than cleared — see `build_full_value` for why an empty array is
/// never written. A missing `usage` section is handled the same way; see
/// `usage::usage_restore_on`.
pub fn apply_full_backup(storage: &Storage, in_path: &str) -> Result<(), String> {
    let file = fs::File::open(in_path).map_err(|e| format!("Failed to open file: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("Not a valid backup archive: {}", e))?;

    // Reject a malformed or hostile archive before anything is read or written:
    // only backup.json and flat .wav recordings are legitimate members.
    validate_archive_entries(&mut archive)?;

    // 1. Read and validate backup.json
    let mut json_str = String::new();
    {
        let mut entry = archive.by_name(BACKUP_ENTRY_NAME).map_err(|_| {
            "The archive is missing backup.json and may not be a SayIt full backup".to_string()
        })?;
        entry
            .read_to_string(&mut json_str)
            .map_err(|e| e.to_string())?;
    }
    let data: Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse backup.json: {}", e))?;
    check_kind_and_version(&data, "full", FULL_FORMAT_VERSION)?;
    // Validate the shape of every setting here; local keys are skipped later,
    // but a full backup is still valid when the only settings it carries are
    // machine-local.
    full_config_preview_sections(&data, &[])?;
    for key in ["history", "manualCorrections", "feedbackQueue"] {
        if let Some(value) = data.get(key) {
            let items = value
                .as_array()
                .ok_or_else(|| format!("{} has an invalid format", key))?;
            validate_config_collection(key, items)?;
        }
    }
    validate_history_audio_paths(&data)?;

    // Validate the usage section up front: a malformed one must abort the
    // restore before any part of it is applied.
    let usage = data.get("usage").map(parse_usage_backup).transpose()?;

    // 2. Publish archive audio, then restore the database in one transaction.
    //    If anything fails, the audio files this restore created are removed;
    //    files that already existed are never touched.
    let adir = audio_dir();
    let mut created = Vec::new();
    let mut restore = || -> Result<(), String> {
        fs::create_dir_all(&adir)
            .map_err(|e| format!("Failed to create audio directory: {}", e))?;
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
            let name = entry.name().to_string();
            let Some(rest) = name.strip_prefix(AUDIO_ENTRY_PREFIX) else {
                continue;
            };
            if rest.is_empty() || entry.is_dir() {
                continue;
            }
            // `validate_archive_entries` already accepted this name; validating
            // again keeps the write path safe on its own and never flattens a
            // hostile name into the audio directory.
            let base = validate_audio_file_name(rest).map_err(|reason| {
                format!("The backup audio entry '{name}' is not allowed: {reason}")
            })?;
            publish_audio_file(&adir, base, &mut entry, &mut created)?;
        }

        let empty_settings = Map::new();
        let app_settings = data
            .get("appSettings")
            .and_then(Value::as_object)
            .unwrap_or(&empty_settings);
        let prompt_presets = array_section(&data, "promptPresets");
        let app_prompt_rules = array_section(&data, "appPromptRules");
        let history = data.get("history").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .map(|record| rewrite_audio_path(record, &adir))
                .collect::<Vec<_>>()
        });
        let manual_corrections = array_section(&data, "manualCorrections");
        let feedback_queue = array_section(&data, "feedbackQueue");

        storage
            .restore_full_transaction(
                app_settings,
                LOCAL_STATE_KEYS,
                prompt_presets,
                app_prompt_rules,
                history.as_deref(),
                manual_corrections,
                feedback_queue,
                usage.as_ref(),
            )
            .map_err(|e| format!("Failed to restore full backup: {}", e))
    };

    if let Err(error) = restore() {
        let removal_failures: Vec<String> = created
            .iter()
            .filter_map(|path| {
                fs::remove_file(path)
                    .err()
                    .map(|remove_error| format!("{}: {}", path.display(), remove_error))
            })
            .collect();
        if removal_failures.is_empty() {
            return Err(error);
        }
        return Err(format!(
            "{error}; also failed to remove restored audio files: {}",
            removal_failures.join("; ")
        ));
    }
    Ok(())
}

/// Called by the frontend after the import completes; restarts the app so
/// in-memory settings and provider state are fully reloaded.
#[tauri::command]
pub fn restart_app(app: tauri::AppHandle) -> Result<(), String> {
    file_transcription::restart_after_file_work(app)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_storage(tag: &str) -> (Storage, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "sayit-backup-test-{}-{}",
            tag,
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&dir).unwrap();
        let storage = Storage::new(dir.join("test.db")).unwrap();
        (storage, dir)
    }

    /// When history is not included, the `history` field must be **absent
    /// entirely**, not an empty array.
    ///
    /// This is the entire basis for safely restoring the config-only profile:
    /// `apply_full_backup` uses `if let Some(history)`, so an absent field keeps
    /// the local history, while an empty array would wipe the local history
    /// table — a user who only wanted to sync settings would lose every record,
    /// and neither the backup nor the restore would report any error.
    #[test]
    fn config_only_backup_omits_history_instead_of_emptying_it() {
        let (storage, dir) = temp_storage("scope");
        storage
            .set(
                "history",
                &json!([{ "id": "h1", "timestamp": 1, "charCount": 3 }]),
            )
            .unwrap();

        let config_only = build_full_value(
            &storage,
            BackupScope {
                include_history: false,
                include_audio: false,
            },
        )
        .unwrap();
        assert!(
            config_only.get("history").is_none(),
            "history must be absent, got {:?}",
            config_only.get("history")
        );
        assert!(config_only.get("manualCorrections").is_none());
        assert!(config_only.get("feedbackQueue").is_none());
        // The configuration part is still present and kind is still full; the
        // existing import path can restore it.
        assert_eq!(
            config_only.get("kind").and_then(Value::as_str),
            Some("full")
        );
        assert!(config_only.get("appSettings").is_some());
        assert_eq!(
            config_only
                .pointer("/scope/includeAudio")
                .and_then(Value::as_bool),
            Some(false)
        );

        let with_history = build_full_value(
            &storage,
            BackupScope {
                include_history: true,
                include_audio: false,
            },
        )
        .unwrap();
        assert_eq!(
            with_history
                .get("history")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(1)
        );

        let _ = fs::remove_dir_all(&dir);
    }

    /// When audio is not included the audio directory is not scanned, so another
    /// backup's recordings cannot be pulled in.
    #[test]
    fn audio_files_are_only_collected_when_requested() {
        assert!(collect_audio_export_files(false).is_empty());
    }

    #[test]
    fn prompt_overrides_allow_one_entry_per_builtin_language() {
        let items = vec![
            json!({
                "id": "intent",
                "name": "Intent cleanup",
                "systemPrompt": "中文自定义",
                "builtinPromptLanguage": "zh-CN",
            }),
            json!({
                "id": "intent",
                "name": "Intent cleanup",
                "systemPrompt": "English custom",
                "builtinPromptLanguage": "en",
            }),
            json!({
                "id": "intent",
                "name": "Intent cleanup",
                "systemPrompt": "Ukrainian custom",
                "builtinPromptLanguage": "uk",
            }),
        ];

        assert!(validate_config_collection("promptPresets", &items).is_ok());
    }

    #[test]
    fn prompt_overrides_reject_duplicate_builtin_language() {
        let items = vec![
            json!({ "id": "intent", "name": "Intent cleanup", "systemPrompt": "First" }),
            json!({
                "id": "intent",
                "name": "Intent cleanup",
                "systemPrompt": "Second",
                "builtinPromptLanguage": "zh-CN",
            }),
        ];

        assert!(validate_config_collection("promptPresets", &items).is_err());
    }

    #[test]
    fn prompt_overrides_reject_unknown_language() {
        let items = vec![json!({
            "id": "intent",
            "name": "Intent cleanup",
            "systemPrompt": "Unknown custom",
            "builtinPromptLanguage": "fr",
        })];

        assert!(validate_config_collection("promptPresets", &items).is_err());
    }

    #[test]
    fn full_backup_preview_rejects_unknown_prompt_language() {
        let data = json!({
            "appSettings": {},
            "promptPresets": [{
                "id": "intent",
                "name": "Intent cleanup",
                "systemPrompt": "Unknown custom",
                "builtinPromptLanguage": "fr",
            }],
            "appPromptRules": [],
        });

        assert!(full_config_preview_sections(&data, &[]).is_err());
    }

    #[test]
    fn selected_import_rejects_corrupt_local_prompt_presets_without_replacing_them() {
        let (storage, dir) = temp_storage("selected-corrupt-prompt-presets");
        storage
            .set(
                "promptPresets",
                &json!([{
                    "id": "local-preset",
                    "name": "Local preset",
                    "systemPrompt": "Keep this preset",
                }]),
            )
            .unwrap();
        storage
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE prompt_presets SET raw_json = '{not-json' WHERE id = 'local-preset'",
                [],
            )
            .unwrap();

        let data = json!({
            "items": {
                "promptPresets": [{
                    "name": "Imported preset",
                    "systemPrompt": "Imported prompt",
                }],
            },
        });
        let error = match build_selected_import_plan(&storage, &data) {
            Ok(_) => panic!("corrupt local prompt presets must reject selected import"),
            Err(error) => error,
        };

        assert!(error.contains("promptPresets"), "unexpected error: {error}");
        let raw_after: String = storage
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT raw_json FROM prompt_presets WHERE id = 'local-preset'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(raw_after, "{not-json");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_usage_aborts_restore_before_any_write() {
        let (storage, dir) = temp_storage("malformed-usage");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        storage
            .set(
                "history",
                &json!([{ "id": "local-1", "timestamp": 1, "charCount": 3 }]),
            )
            .unwrap();
        storage
            .usage_record(
                0,
                &crate::storage::UsageEventInput {
                    char_count: 5,
                    duration_sec: 1.0,
                    app_id: None,
                    work_mode: None,
                    prompt_preset_id: None,
                },
            )
            .unwrap();
        let usage_before = storage.usage_summary(None).unwrap();

        let backup_path = dir.join("malformed-usage.zip");
        let payload = json!({
            "kind": "full",
            "formatVersion": 1,
            "appSettings": { "cloudAi.model": "restored-model" },
            "promptPresets": [],
            "appPromptRules": [],
            "history": [{ "id": "restored-1", "timestamp": 2, "charCount": 9 }],
            "usage": { "events": "nope" },
        });
        {
            let file = fs::File::create(&backup_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("backup.json", zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(serde_json::to_string(&payload).unwrap().as_bytes())
                .unwrap();
            zip.finish().unwrap();
        }

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();
        assert!(error.contains("usage"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        assert_eq!(
            storage.get("history", None),
            json!([{ "id": "local-1", "timestamp": 1, "charCount": 3 }])
        );
        assert_eq!(storage.usage_summary(None).unwrap(), usage_before);

        let _ = fs::remove_dir_all(&dir);
    }

    fn write_backup_zip(path: &Path, payload: &Value, audio: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        zip.start_file("backup.json", options).unwrap();
        zip.write_all(serde_json::to_string(payload).unwrap().as_bytes())
            .unwrap();
        for (name, bytes) in audio {
            zip.start_file(format!("audio/{name}"), options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    /// Writes an archive with caller-provided member names, used to build the
    /// malformed archives the restore must reject.
    fn write_archive_zip(path: &Path, payload: &Value, entries: &[(&str, &[u8])]) {
        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::FileOptions::default();
        zip.start_file("backup.json", options).unwrap();
        zip.write_all(serde_json::to_string(payload).unwrap().as_bytes())
            .unwrap();
        for (name, bytes) in entries {
            zip.start_file(*name, options).unwrap();
            zip.write_all(bytes).unwrap();
        }
        zip.finish().unwrap();
    }

    fn restorable_validation_payload(history: Value) -> Value {
        json!({
            "kind": "full",
            "formatVersion": 2,
            "appSettings": { "cloudAi.model": "restored-model" },
            "promptPresets": [],
            "appPromptRules": [],
            "history": history,
            "usage": {
                "firstUsedAt": null,
                "events": [],
            },
        })
    }

    #[test]
    fn duplicate_history_id_is_rejected_before_database_writes() {
        let (storage, dir) = temp_storage("duplicate-history-id");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let original_history = json!([{ "id": "local-1", "timestamp": 1 }]);
        storage.set("history", &original_history).unwrap();
        let usage_before = storage.usage_summary(None).unwrap();
        let backup_path = dir.join("duplicate-history-id.zip");
        write_backup_zip(
            &backup_path,
            &restorable_validation_payload(json!([
                { "id": "duplicate", "timestamp": 2 },
                { "id": "duplicate", "timestamp": 3 },
            ])),
            &[],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains("history"), "unexpected error: {error}");
        assert!(error.contains("duplicate"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        assert_eq!(storage.get("history", None), original_history);
        assert_eq!(storage.usage_summary(None).unwrap(), usage_before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn non_object_history_entry_is_rejected_before_database_writes() {
        let (storage, dir) = temp_storage("non-object-history");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let original_history = json!([{ "id": "local-1", "timestamp": 1 }]);
        storage.set("history", &original_history).unwrap();
        let backup_path = dir.join("non-object-history.zip");
        write_backup_zip(
            &backup_path,
            &restorable_validation_payload(json!(["not-an-object"])),
            &[],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains("history"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        assert_eq!(storage.get("history", None), original_history);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_history_id_is_rejected_before_database_writes() {
        let (storage, dir) = temp_storage("missing-history-id");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let original_history = json!([{ "id": "local-1", "timestamp": 1 }]);
        storage.set("history", &original_history).unwrap();
        let backup_path = dir.join("missing-history-id.zip");
        write_backup_zip(
            &backup_path,
            &restorable_validation_payload(json!([{ "timestamp": 2 }])),
            &[],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains("history"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        assert_eq!(storage.get("history", None), original_history);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_non_wav_audio_entry_before_writing() {
        let (storage, dir) = temp_storage("reject-non-wav");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let original_history = json!([{ "id": "local-1", "timestamp": 1 }]);
        storage.set("history", &original_history).unwrap();
        let adir = audio_dir();
        fs::create_dir_all(&adir).unwrap();
        let name = format!("reject-{}.exe", uuid::Uuid::new_v4());
        let entry_name = format!("audio/{name}");
        let backup_path = dir.join("reject-non-wav.zip");
        write_archive_zip(
            &backup_path,
            &restorable_validation_payload(json!([{ "id": "restored-1", "timestamp": 2 }])),
            &[(entry_name.as_str(), b"MZ")],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains(".wav"), "unexpected error: {error}");
        assert!(!adir.join(&name).exists());
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        assert_eq!(storage.get("history", None), original_history);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_traversal_audio_entry_before_writing() {
        let (storage, dir) = temp_storage("reject-traversal");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let adir = audio_dir();
        fs::create_dir_all(&adir).unwrap();
        let name = format!("escape-{}.wav", uuid::Uuid::new_v4());
        let entry_name = format!("audio/../{name}");
        let outside = adir.parent().unwrap().join(&name);
        let backup_path = dir.join("reject-traversal.zip");
        write_archive_zip(
            &backup_path,
            &restorable_validation_payload(json!([])),
            &[(entry_name.as_str(), b"escape")],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(
            error.contains("path separator"),
            "unexpected error: {error}"
        );
        assert!(
            !outside.exists(),
            "the traversal entry must not escape the audio directory"
        );
        assert!(
            !adir.join(&name).exists(),
            "a rejected entry must not be flattened into the audio directory"
        );
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_drive_relative_audio_entry() {
        let (storage, dir) = temp_storage("reject-drive-relative");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let name = format!("C:escape-{}.wav", uuid::Uuid::new_v4());
        let entry_name = format!("audio/{name}");
        let backup_path = dir.join("reject-drive-relative.zip");
        write_archive_zip(
            &backup_path,
            &restorable_validation_payload(json!([])),
            &[(entry_name.as_str(), b"escape")],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains("drive"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_unexpected_archive_entries() {
        let (storage, dir) = temp_storage("reject-unexpected-entry");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let name = format!("escape-{}.exe", uuid::Uuid::new_v4());
        let entry_name = format!("../{name}");
        let backup_path = dir.join("reject-unexpected-entry.zip");
        write_archive_zip(
            &backup_path,
            &restorable_validation_payload(json!([])),
            &[(entry_name.as_str(), b"MZ")],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(
            error.contains("unexpected entry"),
            "unexpected error: {error}"
        );
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_duplicate_entries_differing_in_unicode_case() {
        let (storage, dir) = temp_storage("duplicate-unicode-case");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let backup_path = dir.join("duplicate-unicode-case.zip");
        write_archive_zip(
            &backup_path,
            &restorable_validation_payload(json!([])),
            &[
                ("audio/\u{00C4}.wav", b"upper"),
                ("audio/\u{00E4}.wav", b"lower"),
            ],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains("duplicate"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_tolerates_an_audio_directory_entry() {
        let (storage, dir) = temp_storage("audio-dir-entry");
        let adir = audio_dir();
        fs::create_dir_all(&adir).unwrap();
        let name = format!("dir-entry-{}.wav", uuid::Uuid::new_v4());
        let backup_path = dir.join("audio-dir-entry.zip");
        let payload = restorable_validation_payload(json!([{
            "id": "restored-1",
            "timestamp": 2,
            "audioFilePath": format!("C:\\old\\{name}"),
        }]));
        {
            let file = fs::File::create(&backup_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::FileOptions::default();
            zip.start_file("backup.json", options).unwrap();
            zip.write_all(serde_json::to_string(&payload).unwrap().as_bytes())
                .unwrap();
            zip.add_directory("audio/", options).unwrap();
            zip.start_file(format!("audio/{name}"), options).unwrap();
            zip.write_all(b"wav-bytes").unwrap();
            zip.finish().unwrap();
        }

        apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap();

        assert_eq!(fs::read(adir.join(&name)).unwrap(), b"wav-bytes");
        assert_eq!(
            storage.get("history", None)[0]["audioFilePath"],
            json!(adir.join(&name).to_string_lossy())
        );

        let _ = fs::remove_file(adir.join(&name));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_unsafe_history_audio_paths() {
        let (storage, dir) = temp_storage("history-unsafe-path");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        for (index, (path, needle)) in [
            ("../evil.wav", "parent-directory"),
            ("C:evil.exe", "invalid audioFilePath"),
            ("C:evil.wav", "invalid audioFilePath"),
        ]
        .iter()
        .enumerate()
        {
            let payload = restorable_validation_payload(json!([{
                "id": "restored-1",
                "timestamp": 2,
                "audioFilePath": *path,
            }]));
            let backup_path = dir.join(format!("history-unsafe-{index}.zip"));
            write_archive_zip(&backup_path, &payload, &[]);

            let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

            assert!(error.contains(*needle), "unexpected error: {error}");
        }
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_a_backup_without_format_version() {
        let (storage, dir) = temp_storage("missing-version");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let backup_path = dir.join("missing-version.zip");
        let payload = json!({
            "kind": "full",
            "appSettings": { "cloudAi.model": "restored-model" },
            "promptPresets": [],
            "appPromptRules": [],
            "usage": { "firstUsedAt": null, "events": [] },
        });
        write_archive_zip(&backup_path, &payload, &[]);

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains("formatVersion"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_rejects_out_of_range_format_versions() {
        let (storage, dir) = temp_storage("invalid-version");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        for (index, version) in [0_i64, -1, FULL_FORMAT_VERSION + 1].iter().enumerate() {
            let payload = json!({
                "kind": "full",
                "formatVersion": version,
                "appSettings": { "cloudAi.model": "restored-model" },
                "promptPresets": [],
                "appPromptRules": [],
                "usage": { "firstUsedAt": null, "events": [] },
            });
            let backup_path = dir.join(format!("invalid-version-{index}.zip"));
            write_archive_zip(&backup_path, &payload, &[]);

            let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

            assert!(
                error.contains("version") || error.contains("formatVersion"),
                "unexpected error for version {version}: {error}"
            );
        }
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_keeps_local_identity_and_state_but_restores_preferences() {
        let (storage, dir) = temp_storage("local-state");
        let local_state = [
            ("deviceId", json!("local-device")),
            ("autoLaunchInitialized", json!("true")),
            ("autoLaunchArgsMigrated", json!("true")),
            ("webdav.lastResult", json!({ "ok": true })),
            ("webdav.lastBackupAt", json!(111)),
            ("webdav.lastAttemptAt", json!(222)),
        ];
        let saved_preferences = [
            ("autoCheckUpdate", json!(true)),
            ("selectedMic", json!("local-mic")),
            ("systemAudio.deviceId", json!("local-system-mic")),
            ("systemAudio.transcriptDir", json!("C:\\local\\subtitles")),
            ("localAsr.modelsDir", json!("C:\\local\\models")),
            ("localAsr.accelerator", json!("cpu")),
        ];
        for (key, value) in local_state.iter().chain(saved_preferences.iter()) {
            storage.set(key, value).unwrap();
        }
        storage.set("cloudAi.model", &json!("local-model")).unwrap();

        let payload = json!({
            "kind": "full",
            "formatVersion": 2,
            "appSettings": {
                "deviceId": "imported-device",
                "autoCheckUpdate": false,
                "autoLaunchInitialized": "",
                "autoLaunchArgsMigrated": "",
                "selectedMic": "imported-mic",
                "systemAudio.deviceId": "imported-system-mic",
                "systemAudio.transcriptDir": "D:\\imported\\subtitles",
                "localAsr.modelsDir": "D:\\imported\\models",
                "localAsr.accelerator": "gpu",
                "webdav.lastResult": { "ok": false },
                "webdav.lastBackupAt": 999,
                "webdav.lastAttemptAt": 999,
                "cloudAi.model": "restored-model",
            },
            "promptPresets": [],
            "appPromptRules": [],
            "usage": { "firstUsedAt": null, "events": [] },
        });
        let backup_path = dir.join("local-state.zip");
        write_archive_zip(&backup_path, &payload, &[]);
        apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap();

        for (key, value) in &local_state {
            assert_eq!(&storage.get(key, None), value, "{key} must stay local");
        }
        let restored_preferences = [
            ("autoCheckUpdate", json!(false)),
            ("selectedMic", json!("imported-mic")),
            ("systemAudio.deviceId", json!("imported-system-mic")),
            (
                "systemAudio.transcriptDir",
                json!("D:\\imported\\subtitles"),
            ),
            ("localAsr.modelsDir", json!("D:\\imported\\models")),
            ("localAsr.accelerator", json!("gpu")),
        ];
        for (key, value) in &restored_preferences {
            assert_eq!(
                &storage.get(key, None),
                value,
                "{key} must be restored from the backup"
            );
        }
        assert_eq!(storage.get("cloudAi.model", None), json!("restored-model"));

        let exported = build_full_value(
            &storage,
            BackupScope {
                include_history: false,
                include_audio: false,
            },
        )
        .unwrap();
        let settings = exported["appSettings"].as_object().unwrap();
        for key in LOCAL_STATE_KEYS {
            assert!(!settings.contains_key(*key), "{key} must not be exported");
        }
        for (key, value) in &restored_preferences {
            assert_eq!(
                settings.get(*key),
                Some(value),
                "{key} must stay in the backup"
            );
        }
        assert_eq!(
            settings.get("cloudAi.model"),
            Some(&json!("restored-model"))
        );

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn config_import_keeps_local_state_but_applies_user_preferences() {
        let (storage, dir) = temp_storage("config-local-state");
        storage.set("deviceId", &json!("local-device")).unwrap();
        storage.set("autoCheckUpdate", &json!(true)).unwrap();
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let data = json!({
            "appSettings": {
                "deviceId": "imported-device",
                "autoCheckUpdate": false,
                "cloudAi.model": "imported-model",
            },
        });

        apply_config_part(&storage, &data, &config_exclusions()).unwrap();

        assert_eq!(storage.get("deviceId", None), json!("local-device"));
        assert_eq!(storage.get("autoCheckUpdate", None), json!(false));
        assert_eq!(storage.get("cloudAi.model", None), json!("imported-model"));

        // The preview counts only settings the import will actually apply:
        // autoCheckUpdate and cloudAi.model, but not deviceId.
        let preview = full_config_preview_sections(&data, &config_exclusions()).unwrap();
        let app_settings = preview
            .iter()
            .find(|section| section.kind == "appSettings")
            .unwrap();
        assert_eq!((app_settings.total, app_settings.updated), (2, 2));

        let exported = build_config_value(&storage).unwrap();
        let settings = exported["appSettings"].as_object().unwrap();
        for key in LOCAL_STATE_KEYS {
            assert!(!settings.contains_key(*key), "{key} must not be exported");
        }
        assert_eq!(settings.get("autoCheckUpdate"), Some(&json!(false)));

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_names_must_be_flat_wav_files() {
        for valid in ["take.wav", "TAKE.WAV", "take-1.wav"] {
            assert_eq!(validate_audio_file_name(valid).unwrap(), valid);
        }
        for invalid in [
            "",
            ".",
            "..",
            "../take.wav",
            "sub/take.wav",
            "C:take.wav",
            "take.exe",
            "con.wav",
            "take.wav:stream",
            "take.wav ",
            "take?.wav",
        ] {
            assert!(
                validate_audio_file_name(invalid).is_err(),
                "{invalid} must be rejected"
            );
        }
    }

    #[test]
    fn history_audio_paths_are_rewritten_only_for_safe_wav_names() {
        let adir = PathBuf::from("audio-root");
        let rewritten = rewrite_audio_path(
            &json!({ "id": "h1", "audioFilePath": "D:\\old\\take.wav" }),
            &adir,
        );
        assert_eq!(
            rewritten["audioFilePath"],
            json!(adir.join("take.wav").to_string_lossy().to_string())
        );
        let dropped =
            rewrite_audio_path(&json!({ "id": "h2", "audioFilePath": "C:take.wav" }), &adir);
        assert!(dropped.get("audioFilePath").is_none());
    }

    #[test]
    fn audio_export_skips_files_that_are_not_wav() {
        let adir = audio_dir();
        fs::create_dir_all(&adir).unwrap();
        let tag = uuid::Uuid::new_v4();
        let wav = format!("export-check-{tag}.wav");
        let exe = format!("export-check-{tag}.exe");
        fs::write(adir.join(&wav), b"wav").unwrap();
        fs::write(adir.join(&exe), b"exe").unwrap();

        let names = collect_audio_export_files(true)
            .into_iter()
            .map(|file| file.name)
            .collect::<Vec<_>>();
        assert!(names.contains(&wav));
        assert!(!names.contains(&exe));

        let _ = fs::remove_file(adir.join(&wav));
        let _ = fs::remove_file(adir.join(&exe));
    }

    #[test]
    fn existing_audio_with_the_same_name_is_kept_and_reused() {
        let (storage, dir) = temp_storage("audio-same-name");
        let adir = audio_dir();
        fs::create_dir_all(&adir).unwrap();
        let name = format!("restore-same-name-{}.wav", uuid::Uuid::new_v4());
        let existing_path = adir.join(&name);
        let existing_bytes = b"local-audio";
        fs::write(&existing_path, existing_bytes).unwrap();
        let backup_path = dir.join("audio-same-name.zip");
        let payload = json!({
            "kind": "full",
            "formatVersion": 2,
            "appSettings": { "cloudAi.model": "restored-model" },
            "promptPresets": [],
            "appPromptRules": [],
            "history": [{
                "id": "restored-same-name",
                "timestamp": 2,
                "audioFilePath": format!("C:\\old\\{name}"),
            }],
            "usage": { "firstUsedAt": null, "events": [] },
        });
        write_backup_zip(&backup_path, &payload, &[(&name, b"archive-audio")]);

        apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap();
        apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap();

        assert_eq!(fs::read(&existing_path).unwrap(), existing_bytes);
        assert_eq!(
            storage.get("history", None)[0]["audioFilePath"],
            json!(existing_path.to_string_lossy())
        );
        let _ = fs::remove_file(&existing_path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn audio_collision_keeps_existing_file_when_database_restore_fails() {
        let (storage, dir) = temp_storage("audio-collision-failure");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        let original_history = json!([{
            "id": "local-history",
            "timestamp": 1,
            "audioFilePath": "C:\\old\\local.wav",
        }]);
        storage.set("history", &original_history).unwrap();
        storage
            .usage_record(
                0,
                &crate::storage::UsageEventInput {
                    char_count: 5,
                    duration_sec: 1.0,
                    app_id: None,
                    work_mode: None,
                    prompt_preset_id: None,
                },
            )
            .unwrap();
        let usage_before = storage.usage_backup().unwrap();
        storage
            .db
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_restore_usage_audio BEFORE INSERT ON usage_events
                 BEGIN SELECT RAISE(ABORT, 'injected audio restore usage failure'); END;",
            )
            .unwrap();

        let adir = audio_dir();
        fs::create_dir_all(&adir).unwrap();
        let name = format!("restore-failure-{}.wav", uuid::Uuid::new_v4());
        let existing_path = adir.join(&name);
        let existing_bytes = b"old-audio-on-failure";
        fs::write(&existing_path, existing_bytes).unwrap();
        let created_name = format!("restore-created-{}.wav", uuid::Uuid::new_v4());
        let created_path = adir.join(&created_name);
        let backup_path = dir.join("audio-collision-failure.zip");
        let payload = json!({
            "kind": "full",
            "formatVersion": 2,
            "appSettings": { "cloudAi.model": "restored-model" },
            "promptPresets": [],
            "appPromptRules": [],
            "history": [{
                "id": "restored-audio-failure",
                "timestamp": 2,
                "audioFilePath": format!("C:\\old\\{name}"),
            }],
            "usage": {
                "firstUsedAt": null,
                "events": [{
                    "ts": 1,
                    "takes": 1,
                    "charCount": 7,
                    "durationSec": 1.0,
                    "appId": null,
                    "workMode": null,
                    "promptPresetId": null,
                }],
            },
        });
        write_backup_zip(
            &backup_path,
            &payload,
            &[
                (name.as_str(), b"new-audio-on-failure"),
                (created_name.as_str(), b"archive-created"),
            ],
        );

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();

        assert!(error.contains("injected audio restore usage failure"));
        assert!(
            !created_path.exists(),
            "newly created audio must be removed"
        );
        assert_eq!(fs::read(&existing_path).unwrap(), existing_bytes);
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        assert_eq!(storage.get("history", None), original_history);
        assert_eq!(storage.usage_backup().unwrap(), usage_before);

        storage
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_restore_usage_audio")
            .unwrap();
        let _ = fs::remove_file(&existing_path);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn every_full_backup_carries_the_usage_section() {
        let (storage, dir) = temp_storage("usage-section");
        storage
            .usage_record(
                0,
                &crate::storage::UsageEventInput {
                    char_count: 5,
                    duration_sec: 1.0,
                    app_id: None,
                    work_mode: None,
                    prompt_preset_id: None,
                },
            )
            .unwrap();

        for include_history in [false, true] {
            let payload = build_full_value(
                &storage,
                BackupScope {
                    include_history,
                    include_audio: false,
                },
            )
            .unwrap();
            assert_eq!(payload["formatVersion"], 2);
            assert_eq!(payload["usage"]["events"][0]["charCount"], 5);
        }
        drop(storage);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn written_full_backup_restores_usage_into_independent_fresh_database() {
        let (source, source_dir) = temp_storage("archive-source");
        source
            .set(
                "history",
                &json!([{
                    "id": "synthetic-history",
                    "timestamp": 1_800_000,
                    "charCount": 29,
                    "durationSec": 4.0,
                }]),
            )
            .unwrap();
        source
            .usage_record(
                900_000,
                &crate::storage::UsageEventInput {
                    char_count: 17,
                    duration_sec: 2.5,
                    app_id: Some("Code.exe".to_string()),
                    work_mode: Some("local".to_string()),
                    prompt_preset_id: Some("intent".to_string()),
                },
            )
            .unwrap();
        source
            .usage_record(
                1_800_000,
                &crate::storage::UsageEventInput {
                    char_count: 29,
                    duration_sec: 4.0,
                    app_id: Some("Telegram.exe".to_string()),
                    work_mode: Some("cloud_api".to_string()),
                    prompt_preset_id: Some("faithful".to_string()),
                },
            )
            .unwrap();

        let mut source_usage = source.usage_backup().unwrap();
        assert_eq!(source_usage.events.len(), 2);
        let mut legacy_row = source_usage
            .events
            .iter()
            .find(|row| row.app_id.as_deref() == Some("Code.exe"))
            .cloned()
            .expect("the synthetic Code.exe event must exist");
        legacy_row.ts = None;
        legacy_row.takes = 0;
        legacy_row.char_count = 0;
        legacy_row.duration_sec = 0.0;
        legacy_row.app_id = Some("Code.exe".to_string());
        legacy_row.work_mode = None;
        legacy_row.prompt_preset_id = None;
        legacy_row.legacy_profile_chars = Some(20);
        source_usage.events.push(legacy_row);
        source.usage_restore(Some(&source_usage)).unwrap();
        assert_eq!(source.usage_backup().unwrap().events.len(), 3);

        for include_history in [false, true] {
            let archive_path = source_dir.join(format!("archive-{include_history}.zip"));
            write_backup_archive(
                &source,
                BackupScope {
                    include_history,
                    include_audio: false,
                },
                &archive_path,
                &mut |_| {},
            )
            .unwrap();

            let file = fs::File::open(&archive_path).unwrap();
            let mut archive = zip::ZipArchive::new(file).unwrap();
            assert_eq!(archive.len(), 1);
            let mut json_str = String::new();
            archive
                .by_name("backup.json")
                .unwrap()
                .read_to_string(&mut json_str)
                .unwrap();
            let payload: Value = serde_json::from_str(&json_str).unwrap();
            assert_eq!(payload["scope"]["includeHistory"], json!(include_history));
            assert_eq!(payload["scope"]["includeAudio"], json!(false));
            assert_eq!(payload["usage"]["firstUsedAt"], json!(900_000));
            assert_eq!(payload["usage"]["events"].as_array().unwrap().len(), 3);
            for (ts, char_count, duration_sec, app_id, work_mode, prompt_preset_id) in [
                (900_000_i64, 17_i64, 2.5_f64, "Code.exe", "local", "intent"),
                (
                    1_800_000_i64,
                    29_i64,
                    4.0_f64,
                    "Telegram.exe",
                    "cloud_api",
                    "faithful",
                ),
            ] {
                assert!(
                    payload["usage"]["events"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|event| {
                            event["ts"] == json!(ts)
                                && event["charCount"] == json!(char_count)
                                && event["durationSec"] == json!(duration_sec)
                                && event["appId"] == json!(app_id)
                                && event["workMode"] == json!(work_mode)
                                && event["promptPresetId"] == json!(prompt_preset_id)
                        })
                );
            }
            assert!(
                payload["usage"]["events"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|event| {
                        event["ts"].is_null()
                            && event["charCount"] == json!(0)
                            && event["legacyProfileChars"] == json!(20)
                            && event["appId"] == json!("Code.exe")
                    })
            );
            if include_history {
                assert_eq!(
                    payload["history"],
                    json!([{
                        "id": "synthetic-history",
                        "timestamp": 1_800_000,
                        "charCount": 29,
                        "durationSec": 4.0,
                    }])
                );
            } else {
                assert!(payload.get("history").is_none());
            }
            drop(archive);

            let (destination, destination_dir) = temp_storage("archive-destination");
            let before = destination.usage_summary(None).unwrap();
            assert_eq!(
                (
                    before.takes,
                    before.total_chars,
                    before.total_duration_sec,
                    before.first_used_at,
                ),
                (0, 0, 0.0, None)
            );
            assert!(before.apps.is_empty());
            assert_eq!(destination.history_count(None, false).unwrap(), 0);

            apply_full_backup(&destination, &archive_path.to_string_lossy()).unwrap();

            let restored = destination.usage_summary(None).unwrap();
            assert_eq!(
                (
                    restored.takes,
                    restored.total_chars,
                    restored.total_duration_sec,
                    restored.first_used_at,
                    restored.last_used_at,
                ),
                (2, 46, 6.5, Some(900_000), Some(1_800_000))
            );
            assert_eq!(restored.apps.iter().map(|item| item.chars).sum::<i64>(), 66);
            for (actual, expected) in [
                (
                    &restored.apps,
                    vec![("Code.exe", 1_i64, 37_i64), ("Telegram.exe", 1_i64, 29_i64)],
                ),
                (
                    &restored.work_modes,
                    vec![("local", 1_i64, 17_i64), ("cloud_api", 1_i64, 29_i64)],
                ),
                (
                    &restored.prompt_presets,
                    vec![("intent", 1_i64, 17_i64), ("faithful", 1_i64, 29_i64)],
                ),
            ] {
                assert_eq!(actual.len(), expected.len());
                for (key, takes, chars) in expected {
                    assert_eq!(
                        actual
                            .iter()
                            .find(|item| item.key == key)
                            .map(|item| (item.takes, item.chars)),
                        Some((takes, chars))
                    );
                }
            }
            assert_eq!(
                destination.history_count(None, false).unwrap(),
                if include_history { 1 } else { 0 }
            );

            drop(destination);
            let _ = fs::remove_dir_all(destination_dir);
        }

        drop(source);
        let _ = fs::remove_dir_all(source_dir);
    }

    #[test]
    fn full_restore_of_a_format_two_backup_keeps_legacy_profile_chars() {
        let (storage, dir) = temp_storage("format-two-restore");

        let backup_path = dir.join("format-two-restore.zip");
        let payload = json!({
            "kind": "full",
            "formatVersion": 2,
            "appSettings": {},
            "promptPresets": [],
            "appPromptRules": [],
            "usage": {
                "firstUsedAt": 111,
                "events": [
                    {
                        "ts": null,
                        "takes": 6,
                        "charCount": 0,
                        "durationSec": 0.0,
                        "appId": "Code.exe",
                        "workMode": null,
                        "promptPresetId": null,
                        "legacyProfileChars": 700,
                    },
                    {
                        "ts": 222,
                        "takes": 1,
                        "charCount": 25,
                        "durationSec": 3.0,
                        "appId": "Code.exe",
                        "workMode": "cloud_api",
                        "promptPresetId": null,
                    },
                ],
            },
        });
        {
            let file = fs::File::create(&backup_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("backup.json", zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(serde_json::to_string(&payload).unwrap().as_bytes())
                .unwrap();
            zip.finish().unwrap();
        }

        apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap();

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!(
            (summary.takes, summary.total_chars),
            (7, 25),
            "the overall total sums char_count only"
        );
        assert_eq!(
            summary
                .apps
                .iter()
                .find(|item| item.key == "Code.exe")
                .map(|item| (item.takes, item.chars)),
            Some((7, 725)),
            "the profile combines the legacy residual with the dated characters"
        );
        assert_eq!(summary.first_used_at, Some(111));

        drop(storage);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn malformed_legacy_profile_chars_aborts_restore_before_any_write() {
        let (storage, dir) = temp_storage("malformed-profile-chars");
        storage.set("cloudAi.model", &json!("local-model")).unwrap();
        storage
            .set(
                "history",
                &json!([{ "id": "local-1", "timestamp": 1, "charCount": 3 }]),
            )
            .unwrap();
        storage
            .usage_record(
                0,
                &crate::storage::UsageEventInput {
                    char_count: 5,
                    duration_sec: 1.0,
                    app_id: None,
                    work_mode: None,
                    prompt_preset_id: None,
                },
            )
            .unwrap();
        let usage_before = storage.usage_summary(None).unwrap();

        let backup_path = dir.join("malformed-profile-chars.zip");
        let payload = json!({
            "kind": "full",
            "formatVersion": 2,
            "appSettings": { "cloudAi.model": "restored-model" },
            "promptPresets": [],
            "appPromptRules": [],
            "history": [{ "id": "restored-1", "timestamp": 2, "charCount": 9 }],
            "usage": {
                "firstUsedAt": null,
                "events": [{
                    "ts": 5,
                    "takes": 1,
                    "charCount": 0,
                    "durationSec": 0.0,
                    "appId": "Code.exe",
                    "legacyProfileChars": 5,
                }],
            },
        });
        {
            let file = fs::File::create(&backup_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("backup.json", zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(serde_json::to_string(&payload).unwrap().as_bytes())
                .unwrap();
            zip.finish().unwrap();
        }

        let error = apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap_err();
        assert!(error.contains("usage"), "unexpected error: {error}");
        assert_eq!(storage.get("cloudAi.model", None), json!("local-model"));
        assert_eq!(
            storage.get("history", None),
            json!([{ "id": "local-1", "timestamp": 1, "charCount": 3 }])
        );
        assert_eq!(storage.usage_summary(None).unwrap(), usage_before);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn full_restore_applies_the_usage_section_from_the_archive() {
        let (storage, dir) = temp_storage("usage-restore");
        storage
            .usage_record(
                0,
                &crate::storage::UsageEventInput {
                    char_count: 5,
                    duration_sec: 1.0,
                    app_id: None,
                    work_mode: None,
                    prompt_preset_id: None,
                },
            )
            .unwrap();

        let backup_path = dir.join("usage-restore.zip");
        let payload = json!({
            "kind": "full",
            "formatVersion": 1,
            "appSettings": {},
            "promptPresets": [],
            "appPromptRules": [],
            "usage": {
                "firstUsedAt": 111,
                "events": [{
                    "ts": 222,
                    "takes": 1,
                    "charCount": 42,
                    "durationSec": 3.0,
                    "appId": "Code.exe",
                    "workMode": "cloud_api",
                    "promptPresetId": null,
                }],
            },
        });
        {
            let file = fs::File::create(&backup_path).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            zip.start_file("backup.json", zip::write::FileOptions::default())
                .unwrap();
            zip.write_all(serde_json::to_string(&payload).unwrap().as_bytes())
                .unwrap();
            zip.finish().unwrap();
        }

        apply_full_backup(&storage, &backup_path.to_string_lossy()).unwrap();

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!(
            (
                summary.takes,
                summary.total_chars,
                summary.total_duration_sec
            ),
            (1, 42, 3.0),
            "the backup's usage must replace the local usage, not be ignored or appended"
        );
        assert_eq!(summary.first_used_at, Some(111));

        drop(storage);
        let _ = fs::remove_dir_all(&dir);
    }
}

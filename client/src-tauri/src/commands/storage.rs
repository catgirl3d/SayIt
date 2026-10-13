use crate::storage::{Storage, UsageEventInput, UsageSummary};
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub fn store_get(key: String, storage: State<Storage>) -> Result<Value, String> {
    Ok(storage.get(&key, None))
}

#[tauri::command]
pub fn store_set(key: String, value: Value, storage: State<Storage>) -> Result<(), String> {
    storage.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_set_app_settings(
    settings: serde_json::Map<String, Value>,
    storage: State<Storage>,
) -> Result<(), String> {
    storage
        .set_app_settings(&settings)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_delete(key: String, storage: State<Storage>) -> Result<(), String> {
    storage.delete(&key).map_err(|e| e.to_string())
}

/// Records one completed dictation in the usage log. The timestamp is taken
/// here rather than from the webview so it cannot be spoofed or skewed.
#[tauri::command]
pub async fn usage_record(
    event: UsageEventInput,
    storage: State<'_, Storage>,
) -> Result<(), String> {
    event.validate()?;
    storage
        .usage_record(chrono::Utc::now().timestamp_millis(), &event)
        .map_err(|e| e.to_string())
}

/// Aggregates the usage log for the home totals and the usage page. Async so
/// the aggregate runs off the main thread, like the other heavy commands.
#[tauri::command]
pub async fn usage_summary(
    since_ms: Option<i64>,
    storage: State<'_, Storage>,
) -> Result<UsageSummary, String> {
    storage.usage_summary(since_ms).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn usage_clear(storage: State<Storage>) -> Result<(), String> {
    storage.usage_clear().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_list(query: Option<Value>, storage: State<Storage>) -> Result<Vec<Value>, String> {
    let (keyword, favorite_only, limit, offset) = parse_history_query(&query);
    Ok(storage.history_list(keyword.as_deref(), favorite_only, limit, offset))
}

#[tauri::command]
pub fn history_count(query: Option<Value>, storage: State<Storage>) -> Result<i64, String> {
    let (keyword, favorite_only, _, _) = parse_history_query(&query);
    Ok(storage.history_count(keyword.as_deref(), favorite_only))
}

#[tauri::command]
pub fn history_add(record: Value, storage: State<Storage>) -> Result<(), String> {
    storage.history_add(&record).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_update(id: String, patch: Value, storage: State<Storage>) -> Result<(), String> {
    storage
        .history_update(&id, &patch)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_delete(id: String, storage: State<Storage>) -> Result<(), String> {
    storage.history_delete(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_set_favorite(
    id: String,
    favorite: bool,
    storage: State<Storage>,
) -> Result<(), String> {
    storage
        .history_set_favorite(&id, favorite)
        .map_err(|e| e.to_string())
}

/// Deletes the whole history (records and the audio recordings on disk).
/// Usage statistics live in `usage_events` and are not touched. Audio deletion
/// is best-effort: the records are already gone, so a locked file must not turn
/// a successful clear into an error — it is logged and the orphaned file is
/// left behind.
#[tauri::command]
pub fn history_clear(storage: State<Storage>) -> Result<(), String> {
    let summary = storage.history_clear().map_err(|e| e.to_string())?;
    for path in summary.audio_file_paths {
        if let Err(error) = crate::commands::audio::delete_audio_file(path.clone()) {
            log::warn!(
                "history_clear: failed to delete audio file {}: {}",
                path,
                error
            );
        }
    }
    Ok(())
}

fn parse_history_query(query: &Option<Value>) -> (Option<String>, bool, Option<i64>, Option<i64>) {
    match query {
        Some(v) => {
            let keyword = v
                .get("keyword")
                .and_then(|k| k.as_str())
                .map(|s| s.to_string());
            let favorite_only = v
                .get("favoriteOnly")
                .and_then(|f| f.as_bool())
                .unwrap_or(false);
            let limit = v.get("limit").and_then(|l| l.as_i64());
            let offset = v.get("offset").and_then(|o| o.as_i64());
            (keyword, favorite_only, limit, offset)
        }
        None => (None, false, None, None),
    }
}

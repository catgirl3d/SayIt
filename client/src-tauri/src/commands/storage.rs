use crate::net_policy::{BACKEND_BASE_URL_KEY, TlsPolicyState};
use crate::storage::{Storage, UsageEventInput, UsageSummary};
use serde_json::Value;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn store_get(key: String, storage: State<Storage>) -> Result<Value, String> {
    Ok(storage.get(&key, None))
}

/// The backend address decides which host gets the certificate exception, so only the
/// dedicated async commands below may change it: they clear WebView2's cached certificate
/// decisions around the write. The generic store commands stay synchronous on purpose. A
/// sync command runs inline on the IPC thread in arrival order, while an async one is
/// spawned on the runtime pool, so making them async would let fire-and-forget settings
/// writes land out of order.
fn backend_base_url_rejection(command: &str) -> String {
    format!(
        "'{BACKEND_BASE_URL_KEY}' cannot be changed through {command}; use store_set_backend_url or store_delete_backend_url"
    )
}

#[tauri::command]
pub fn store_set(key: String, value: Value, storage: State<Storage>) -> Result<(), String> {
    if key == BACKEND_BASE_URL_KEY {
        return Err(backend_base_url_rejection("store_set"));
    }
    storage.set(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_set_app_settings(
    settings: serde_json::Map<String, Value>,
    storage: State<Storage>,
) -> Result<(), String> {
    if settings.contains_key(BACKEND_BASE_URL_KEY) {
        return Err(backend_base_url_rejection("store_set_app_settings"));
    }
    storage
        .set_app_settings(&settings)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn store_delete(key: String, storage: State<Storage>) -> Result<(), String> {
    if key == BACKEND_BASE_URL_KEY {
        return Err(backend_base_url_rejection("store_delete"));
    }
    storage.delete(&key).map_err(|e| e.to_string())
}

/// Saves the custom backend address and moves the certificate exception to its host.
/// Async because the policy change waits for the WebView2 cache clear, which is dispatched
/// to the main thread; blocking inside a sync command would deadlock on it.
#[tauri::command]
pub async fn store_set_backend_url(
    url: String,
    storage: State<'_, Storage>,
    app: AppHandle,
    tls_policy: State<'_, TlsPolicyState>,
) -> Result<(), String> {
    let policy = (*tls_policy).clone();
    let clear_app = app.clone();
    policy
        .apply_backend_change(
            Some(url.clone()),
            move || TlsPolicyState::clear_cached_actions(clear_app),
            move || {
                storage
                    .set(BACKEND_BASE_URL_KEY, &Value::String(url))
                    .map_err(|error| error.to_string())
            },
        )
        .await
}

/// Removes the custom backend address and revokes the certificate exception.
#[tauri::command]
pub async fn store_delete_backend_url(
    storage: State<'_, Storage>,
    app: AppHandle,
    tls_policy: State<'_, TlsPolicyState>,
) -> Result<(), String> {
    let policy = (*tls_policy).clone();
    let clear_app = app.clone();
    policy
        .apply_backend_change(
            None,
            move || TlsPolicyState::clear_cached_actions(clear_app),
            move || {
                storage
                    .delete(BACKEND_BASE_URL_KEY)
                    .map_err(|error| error.to_string())
            },
        )
        .await
}

#[tauri::command]
pub async fn wait_for_backend_tls_ready(
    tls_policy: State<'_, TlsPolicyState>,
) -> Result<(), String> {
    tls_policy.wait_ready().await
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
    storage
        .history_list(keyword.as_deref(), favorite_only, limit, offset)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_count(query: Option<Value>, storage: State<Storage>) -> Result<i64, String> {
    let (keyword, favorite_only, _, _) = parse_history_query(&query);
    storage
        .history_count(keyword.as_deref(), favorite_only)
        .map_err(|e| e.to_string())
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

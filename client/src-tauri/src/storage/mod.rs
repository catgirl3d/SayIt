use rusqlite::{
    Connection, DatabaseName, OpenFlags, OptionalExtension, Result as SqlResult, params,
};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod usage;

pub use usage::{UsageBackup, UsageEventInput, UsageSummary, parse_usage_backup};

/// Default settings values (mirrors electron-app/electron/store.ts)
const DEFAULT_SETTINGS: &[(&str, &str)] = &[
    // Default push-to-talk key. It must not be Shift: holding the right Shift
    // key enables Windows Filter Keys, which leaves recording running after the
    // key is released. Keep this in sync with src/services/defaults.ts and
    // DEFAULT_PTT_SETTING in keyboard/mod.rs.
    ("shortcutPTT", r#""ControlRight""#),
    ("shortcutPTTCombo", r#""Alt+Q""#),
    ("shortcutHandsFree", r#""AltRight""#),
    ("shortcutToggleAi", r#""""#),
    ("autoLaunch", "true"),
    ("selectedMic", r#""""#),
    ("hotwords", "[]"),
    ("builtinHotwordSets", r#"{"ai":false}"#),
    ("activePresetId", r#""intent""#),
];

/// Collection keys that map to dedicated tables instead of app_settings
const COLLECTION_KEYS: &[&str] = &[
    "history",
    "manualCorrections",
    "feedbackQueue",
    "promptPresets",
    "appPromptRules",
];

pub(crate) const BUILTIN_PROMPT_IDS: &[&str] = &[
    "intent",
    "faithful",
    "translate_uk",
    "translate_ru",
    "translate_en",
    "casual",
];

fn prompt_preset_storage_key(id: &str, raw_json: &str) -> String {
    if !BUILTIN_PROMPT_IDS.contains(&id) {
        return format!("custom:{id}");
    }

    let language = serde_json::from_str::<Value>(raw_json)
        .ok()
        .and_then(|value| {
            value
                .get("builtinPromptLanguage")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .filter(|language| matches!(language.as_str(), "zh-CN" | "en" | "uk"))
        .unwrap_or_else(|| "zh-CN".to_owned());
    format!("builtin:{id}:{language}")
}

fn is_collection_key(key: &str) -> bool {
    COLLECTION_KEYS.contains(&key)
}

fn collection_table(key: &str) -> Option<&'static str> {
    match key {
        "history" => Some("history_records"),
        "manualCorrections" => Some("manual_corrections"),
        "feedbackQueue" => Some("feedback_queue"),
        "promptPresets" => Some("prompt_presets"),
        "appPromptRules" => Some("app_prompt_rules"),
        _ => None,
    }
}

fn json_conversion_error(context: impl Into<String>, error: serde_json::Error) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!("{}: {}", context.into(), error),
        )),
    )
}

/// The migration versions this binary applies. `apply_migrations` decides its
/// branches from these same bindings and `pending_migration_versions` tests
/// them as one set, so the pending decision cannot drift from what runs.
/// Version 4 is deliberately absent: older builds recorded an unrelated
/// `seed-stats-total-sessions` marker under that number, so the applied set
/// must be these explicit versions - never a contiguous 1..=5 range or
/// MAX(version), which would both misread a foreign version 4 as ours.
const MIGRATION_INIT_VERSION: i64 = 1;
const MIGRATION_AUDIO_FILE_PATH_VERSION: i64 = 2;
const MIGRATION_PROMPT_PRESET_KEYS_VERSION: i64 = 3;
const MIGRATION_USAGE_EVENTS_VERSION: i64 = 5;
const MIGRATION_VERSIONS: [i64; 4] = [
    MIGRATION_INIT_VERSION,
    MIGRATION_AUDIO_FILE_PATH_VERSION,
    MIGRATION_PROMPT_PRESET_KEYS_VERSION,
    MIGRATION_USAGE_EVENTS_VERSION,
];

pub struct Storage {
    pub db: Mutex<Connection>,
}

/// Outcome of clearing the whole history: the caller (the Tauri command layer)
/// deletes the listed audio recordings from disk, which storage must not touch.
pub struct HistoryClearSummary {
    pub audio_file_paths: Vec<String>,
}

impl Storage {
    pub fn new(db_path: PathBuf) -> SqlResult<Self> {
        if let Some(parent) = db_path.parent() {
            let _ = fs::create_dir_all(parent);
        }

        let conn = Connection::open(&db_path)?;
        // Snapshot before anything else can touch the file: the WAL pragma may
        // checkpoint the existing log and the migrations below rewrite the
        // schema. A failed snapshot must abort startup while the database is
        // still exactly the state the backup saw.
        Self::snapshot_before_migrations(&conn, &db_path)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;

        let storage = Self {
            db: Mutex::new(conn),
        };
        storage.apply_migrations()?;
        storage.seed_defaults()?;
        Ok(storage)
    }

    /// Writes one verified snapshot beside `db_path` when the database still
    /// has pending migrations, so the pre-migration state survives however
    /// many migrations run this startup. Databases with nothing to preserve -
    /// fresh files, `:memory:`, or a database whose supported migrations are
    /// all recorded - return without writing.
    fn snapshot_before_migrations(conn: &Connection, db_path: &Path) -> SqlResult<()> {
        let pending = match Self::pending_migration_versions(conn)? {
            Some(pending) => pending,
            None => return Ok(()),
        };
        if pending.is_empty() {
            return Ok(());
        }

        let destination = Self::migration_snapshot_path(db_path);
        log::info!(
            "Pending migrations {:?}: writing pre-migration backup to {}",
            pending,
            destination.display()
        );
        match Self::create_verified_snapshot(conn, &destination) {
            Ok(()) => {
                log::info!("Pre-migration backup verified: {}", destination.display());
                Ok(())
            }
            Err(error) => {
                // The snapshot is the only copy of the pre-migration state:
                // without it a broken migration would be unrecoverable, so
                // abort startup instead of migrating anyway.
                log::error!("Pre-migration backup failed: {error}");
                Err(error)
            }
        }
    }

    /// The supported migration versions missing from `schema_migrations`, or
    /// `None` when the file has no user schema at all (fresh or `:memory:`)
    /// and there is nothing worth keeping. Read errors propagate: an
    /// unreadable migration state aborts startup, it is never treated as
    /// fresh. A database with user tables but no marker table predates
    /// migrations entirely, so every version is pending.
    fn pending_migration_versions(conn: &Connection) -> SqlResult<Option<Vec<i64>>> {
        let user_tables: i64 = conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
            [],
            |row| row.get(0),
        )?;
        if user_tables == 0 {
            return Ok(None);
        }

        let has_marker_table: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations')",
            [],
            |row| row.get(0),
        )?;
        if !has_marker_table {
            return Ok(Some(MIGRATION_VERSIONS.to_vec()));
        }

        let mut pending = Vec::new();
        for &version in &MIGRATION_VERSIONS {
            if !Self::migration_exists(conn, version)? {
                pending.push(version);
            }
        }
        Ok(Some(pending))
    }

    /// Snapshot destination, derived from the database file itself and placed
    /// directly beside it: `<stem>-before-migration-<UTC>-<uuid>.sqlite3`. The
    /// timestamp keeps copies sortable, the UUID keeps two startups within
    /// the same second from colliding.
    fn migration_snapshot_path(db_path: &Path) -> PathBuf {
        let stem = db_path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_else(|| "sayit".to_owned());
        let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%SZ");
        db_path.with_file_name(format!(
            "{stem}-before-migration-{stamp}-{}.sqlite3",
            uuid::Uuid::new_v4()
        ))
    }

    /// Copies the live database - WAL content included - to `destination`,
    /// leaves the copy as a self-contained rollback-journal file, and verifies
    /// it before it is trusted. The destination is reserved with `create_new`
    /// first so an existing file is never reused or overwritten; a copy whose
    /// backup, normalization, or verification fails is removed and its error
    /// propagates, aborting startup before any migration ran.
    fn create_verified_snapshot(conn: &Connection, destination: &Path) -> SqlResult<()> {
        // The reservation handle closes here, before SQLite opens the same
        // path to fill it in.
        if let Err(error) = fs::File::create_new(destination) {
            return Err(Self::snapshot_failure(destination, error));
        }

        if let Err(error) = conn.backup(DatabaseName::Main, destination, None) {
            Self::remove_failed_snapshot(destination);
            return Err(Self::snapshot_failure(destination, error));
        }

        if let Err(error) = Self::normalize_snapshot_journal_mode(destination) {
            Self::remove_failed_snapshot(destination);
            return Err(error);
        }

        if let Err(error) = Self::verify_snapshot(destination) {
            Self::remove_failed_snapshot(destination);
            return Err(error);
        }
        Ok(())
    }

    /// Rewrites the fresh copy out of WAL mode before it is verified. The
    /// backup copies the source header verbatim, so the copy claims WAL mode
    /// and would need `-wal`/`-shm` sidecars wherever it is opened - from
    /// read-only media it could not be opened at all. The copy carries no WAL
    /// of its own, so switching it to the ordinary rollback journal costs
    /// nothing and leaves one self-contained file. The destination is opened
    /// read-write WITHOUT create: a copy that vanished after the backup must
    /// fail here, not be recreated as an empty database that would pass
    /// verification. The writable connection closes here, before the
    /// read-only verification opens the result.
    fn normalize_snapshot_journal_mode(destination: &Path) -> SqlResult<()> {
        let mode: String =
            Connection::open_with_flags(destination, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .and_then(|copy| {
                    copy.query_row("PRAGMA journal_mode = DELETE", [], |row| row.get(0))
                })
                .map_err(|error| Self::snapshot_failure(destination, error))?;
        if !mode.eq_ignore_ascii_case("delete") {
            return Err(Self::snapshot_failure(
                destination,
                format!("journal_mode normalization returned {mode:?}"),
            ));
        }
        Ok(())
    }

    /// Best-effort removal of an incomplete snapshot this startup just wrote,
    /// together with the `-wal`/`-shm`/`-journal` files SQLite may have
    /// attached to it: the backup error is what aborts startup, and no part of
    /// the failed attempt may survive it.
    fn remove_failed_snapshot(destination: &Path) {
        let mut targets = vec![destination.to_path_buf()];
        for suffix in ["-wal", "-shm", "-journal"] {
            let mut name = destination.as_os_str().to_os_string();
            name.push(suffix);
            targets.push(PathBuf::from(name));
        }
        for target in &targets {
            if let Err(error) = fs::remove_file(target) {
                // An absent file is the normal case; anything else matters.
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "Could not remove the failed pre-migration backup file {}: {}",
                        target.display(),
                        error
                    );
                }
            }
        }
    }

    /// Reads the fresh snapshot back through a plain read-only connection -
    /// never `Storage::new`, which would migrate the copy - and accepts it
    /// only when `PRAGMA quick_check` returns a non-empty list of `ok` rows.
    fn verify_snapshot(destination: &Path) -> SqlResult<()> {
        let check = match Connection::open_with_flags(destination, OpenFlags::SQLITE_OPEN_READ_ONLY)
        {
            Ok(check) => check,
            Err(error) => return Err(Self::snapshot_failure(destination, error)),
        };
        let results = check
            .prepare("PRAGMA quick_check")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<SqlResult<Vec<String>>>()
            });
        match results {
            Ok(rows) if !rows.is_empty() && rows.iter().all(|row| row == "ok") => Ok(()),
            Ok(rows) => Err(Self::snapshot_failure(
                destination,
                format!("quick_check reported {rows:?}"),
            )),
            Err(error) => Err(Self::snapshot_failure(destination, error)),
        }
    }

    /// Adds destination and failure context to an error that would otherwise
    /// surface as a bare SQLite or filesystem code.
    fn snapshot_failure(destination: &Path, error: impl std::fmt::Display) -> rusqlite::Error {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!(
                "pre-migration backup to {} failed: {error}",
                destination.display()
            ),
        )))
    }

    fn apply_migrations(&self) -> SqlResult<()> {
        let db = self.db.lock().unwrap();

        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at INTEGER NOT NULL
            )",
        )?;

        // Migration 1: init
        if !Self::migration_exists(&db, MIGRATION_INIT_VERSION)? {
            db.execute_batch(include_str!("migration_001.sql"))?;
            db.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![
                    MIGRATION_INIT_VERSION,
                    "init-sqlite-storage",
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
        }

        // Migration 2: add audio_file_path
        if !Self::migration_exists(&db, MIGRATION_AUDIO_FILE_PATH_VERSION)? {
            db.execute_batch("ALTER TABLE history_records ADD COLUMN audio_file_path TEXT;")?;
            db.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![
                    MIGRATION_AUDIO_FILE_PATH_VERSION,
                    "add-audio-file-path",
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
        }

        // Migration 3: allow one built-in prompt override per language.
        if !Self::migration_exists(&db, MIGRATION_PROMPT_PRESET_KEYS_VERSION)? {
            Self::migrate_prompt_preset_keys(&db)?;
            db.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![
                    MIGRATION_PROMPT_PRESET_KEYS_VERSION,
                    "add-prompt-preset-language-key",
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
        }

        // Migration 5: anonymous usage events, seeded from history and the
        // legacy counters. The SQL file moved here from migration 4 because
        // version 4 can already be occupied in existing databases by an
        // unrelated marker (seed-stats-total-sessions), which the old
        // version-4 guard mistook for a completed usage migration and skipped
        // the table creation entirely. The branch below is decided from the
        // table itself: an existing usage_events - written by the previous
        // add-usage-events version 4, even if the user has cleared it since -
        // only gains the nullable legacy_profile_chars column and is never
        // rebuilt, while a missing table is created and backfilled once. One
        // transaction: a crash midway must not leave a half-filled table,
        // which the "only when empty" backfill would then skip forever.
        if !Self::migration_exists(&db, MIGRATION_USAGE_EVENTS_VERSION)? {
            let tx = db.unchecked_transaction()?;
            if usage::usage_events_exists(&tx)? {
                tx.execute_batch(usage::MIGRATION_005_ADD_LEGACY_PROFILE_CHARS_SQL)?;
            } else {
                tx.execute_batch(usage::MIGRATION_005_SQL)?;
                usage::rebuild_usage_from_legacy(&tx)?;
            }
            tx.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, ?3)",
                params![
                    MIGRATION_USAGE_EVENTS_VERSION,
                    "add-usage-events",
                    chrono::Utc::now().timestamp_millis()
                ],
            )?;
            tx.commit()?;
        }

        Ok(())
    }

    fn migration_exists(db: &Connection, version: i64) -> SqlResult<bool> {
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM schema_migrations WHERE version = ?1",
            params![version],
            |row| row.get(0),
        )?;
        Ok(count > 0)
    }

    fn migrate_prompt_preset_keys(db: &Connection) -> SqlResult<()> {
        let rows: Vec<(String, i64, Option<String>, String)> = {
            let mut stmt = db.prepare(
                "SELECT id, list_order, name, raw_json FROM prompt_presets ORDER BY list_order ASC",
            )?;
            let mapped_rows = stmt.query_map([], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
            })?;
            let collected_rows = mapped_rows.collect::<Result<Vec<_>, _>>()?;
            collected_rows
        };
        let tx = db.unchecked_transaction()?;
        tx.execute_batch(
            "CREATE TABLE prompt_presets_v3 (
                storage_key TEXT PRIMARY KEY,
                id TEXT NOT NULL,
                list_order INTEGER NOT NULL,
                name TEXT,
                raw_json TEXT NOT NULL
            );",
        )?;
        for (id, list_order, name, raw_json) in rows {
            let storage_key = prompt_preset_storage_key(&id, &raw_json);
            tx.execute(
                "INSERT INTO prompt_presets_v3 (storage_key, id, list_order, name, raw_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![storage_key, id, list_order, name, raw_json],
            )?;
        }
        tx.execute_batch(
            "DROP TABLE prompt_presets;
             ALTER TABLE prompt_presets_v3 RENAME TO prompt_presets;
             CREATE INDEX idx_prompt_presets_order ON prompt_presets(list_order);",
        )?;
        tx.commit()
    }

    fn seed_defaults(&self) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        let now = chrono::Utc::now().timestamp_millis();

        for &(key, value_json) in DEFAULT_SETTINGS {
            let exists: bool = db.query_row(
                "SELECT COUNT(*) > 0 FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )?;
            if !exists {
                db.execute(
                    "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)",
                    params![key, value_json, now],
                )?;
            }
        }
        Ok(())
    }

    // ─── Get / Set / Delete ───

    /// Tolerant read for normal settings and legacy consumers. Checked export
    /// paths use `export_collection` or `export_app_settings` instead.
    pub fn get(&self, key: &str, fallback: Option<&Value>) -> Value {
        if is_collection_key(key) {
            return self.export_collection(key).unwrap_or(Value::Array(vec![]));
        }

        let db = self.db.lock().unwrap();
        let result: Option<String> = db
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .ok();

        match result {
            Some(json_str) => serde_json::from_str(&json_str)
                .unwrap_or_else(|_| fallback.cloned().unwrap_or(Value::Null)),
            None => {
                // Check defaults
                for &(k, v) in DEFAULT_SETTINGS {
                    if k == key {
                        return serde_json::from_str(v).unwrap_or(Value::Null);
                    }
                }
                fallback.cloned().unwrap_or(Value::Null)
            }
        }
    }

    pub fn set(&self, key: &str, value: &Value) -> SqlResult<()> {
        if is_collection_key(key) {
            let items = match value {
                Value::Array(arr) => arr.clone(),
                _ => vec![],
            };
            return self.replace_collection(key, &items);
        }

        let db = self.db.lock().unwrap();
        let json_str = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
        let now = chrono::Utc::now().timestamp_millis();

        db.execute(
            "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
            params![key, json_str, now],
        )?;
        Ok(())
    }

    /// Save ordinary settings atomically without bypassing collection-specific storage.
    pub fn set_app_settings(&self, settings: &serde_json::Map<String, Value>) -> SqlResult<()> {
        if let Some(key) = settings.keys().find(|key| is_collection_key(key)) {
            return Err(rusqlite::Error::InvalidParameterName(key.clone()));
        }
        self.apply_config_transaction(settings, &[], None, None)
    }

    pub fn delete(&self, key: &str) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        if let Some(table) = collection_table(key) {
            db.execute(&format!("DELETE FROM {}", table), [])?;
        } else {
            db.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?;
        }
        Ok(())
    }

    // ─── History ───

    pub fn history_list(
        &self,
        keyword: Option<&str>,
        favorite_only: bool,
        limit: Option<i64>,
        offset: Option<i64>,
    ) -> SqlResult<Vec<Value>> {
        let db = self.db.lock().unwrap();
        let mut where_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if favorite_only {
            where_clauses.push("favorite = 1".to_string());
        }
        if let Some(kw) = keyword {
            let trimmed = kw.trim().to_lowercase();
            if !trimmed.is_empty() {
                where_clauses.push(format!("LOWER(raw_json) LIKE ?{}", param_values.len() + 1));
                param_values.push(Box::new(format!("%{}%", trimmed)));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let limit_sql = match limit {
            Some(l) if l > 0 => {
                let off = offset.unwrap_or(0).max(0);
                format!(" LIMIT {} OFFSET {}", l, off)
            }
            _ => String::new(),
        };

        let sql = format!(
            "SELECT raw_json FROM history_records {} ORDER BY list_order ASC{}",
            where_sql, limit_sql
        );

        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let mut stmt = db.prepare(&sql)?;
        let rows: Vec<String> = stmt
            .query_map(params_ref.as_slice(), |row| {
                let json_str: String = row.get(0)?;
                Ok(json_str)
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        rows.into_iter()
            .enumerate()
            .map(|(index, json_str)| {
                serde_json::from_str(&json_str)
                    .map_err(|error| json_conversion_error(format!("history row {index}"), error))
            })
            .collect()
    }

    pub fn history_count(&self, keyword: Option<&str>, favorite_only: bool) -> SqlResult<i64> {
        let db = self.db.lock().unwrap();
        let mut where_clauses = Vec::new();
        let mut param_values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if favorite_only {
            where_clauses.push("favorite = 1".to_string());
        }
        if let Some(kw) = keyword {
            let trimmed = kw.trim().to_lowercase();
            if !trimmed.is_empty() {
                where_clauses.push(format!("LOWER(raw_json) LIKE ?{}", param_values.len() + 1));
                param_values.push(Box::new(format!("%{}%", trimmed)));
            }
        }

        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", where_clauses.join(" AND "))
        };

        let sql = format!("SELECT COUNT(*) FROM history_records {}", where_sql);
        let params_ref: Vec<&dyn rusqlite::types::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();

        db.query_row(&sql, params_ref.as_slice(), |row| row.get(0))
    }

    /// Adds a record at the top of the history without touching any existing row.
    ///
    /// `list_order` only matters for sorting and does not need to be contiguous,
    /// so the new record takes the current minimum minus one instead of shifting
    /// the whole table by one. Shifting rewrote every row and two indexes, which
    /// cost milliseconds to hundreds of milliseconds on a large history and
    /// blocked the connection while the dictated text waited to be inserted.
    /// Reading the minimum and inserting happen in one transaction: one commit,
    /// and a failed insert (for example a duplicate id) leaves the table
    /// unchanged. The value may be negative; `history_delete` still preserves
    /// the order across the sign change because it shifts every later row by -1.
    pub fn history_add(&self, record: &Value) -> SqlResult<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;

        let list_order: i64 = tx.query_row(
            "SELECT COALESCE(MIN(list_order), 0) - 1 FROM history_records",
            [],
            |row| row.get(0),
        )?;

        let obj = record.as_object().cloned().unwrap_or_default();
        let id = obj.get("id").and_then(|v| v.as_str()).unwrap_or("unknown");
        let timestamp = obj.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let favorite = obj
            .get("favorite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let char_count = obj.get("charCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let duration_sec = obj
            .get("durationSec")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let is_empty = obj
            .get("isEmpty")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let app_id = obj.get("appId").and_then(|v| v.as_str());
        let app_name = obj.get("appName").and_then(|v| v.as_str());
        let audio_file_path = obj.get("audioFilePath").and_then(|v| v.as_str());
        let raw_json = serde_json::to_string(record).unwrap_or_else(|_| "{}".to_string());

        tx.execute(
            "INSERT INTO history_records (id, list_order, timestamp, favorite, char_count, duration_sec, is_empty, app_id, app_name, audio_file_path, raw_json)
             VALUES (?1, ?11, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![id, timestamp, favorite as i32, char_count, duration_sec, is_empty as i32, app_id, app_name, audio_file_path, raw_json, list_order],
        )?;

        tx.commit()
    }

    pub fn history_update(&self, id: &str, patch: &Value) -> SqlResult<()> {
        let db = self.db.lock().unwrap();

        let row: Option<(i64, String)> = db
            .query_row(
                "SELECT list_order, raw_json FROM history_records WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        let (_list_order, raw_json) = match row {
            Some(r) => r,
            None => return Ok(()),
        };

        let mut prev: serde_json::Map<String, Value> =
            serde_json::from_str(&raw_json).unwrap_or_default();

        if let Some(patch_obj) = patch.as_object() {
            for (k, v) in patch_obj {
                prev.insert(k.clone(), v.clone());
            }
        }

        let next = Value::Object(prev.clone());
        let timestamp = prev.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let favorite = prev
            .get("favorite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let char_count = prev.get("charCount").and_then(|v| v.as_i64()).unwrap_or(0);
        let duration_sec = prev
            .get("durationSec")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let is_empty = prev
            .get("isEmpty")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let app_id = prev
            .get("appId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let app_name = prev
            .get("appName")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let audio_file_path = prev
            .get("audioFilePath")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let new_json = serde_json::to_string(&next).unwrap_or_else(|_| "{}".to_string());

        db.execute(
            "UPDATE history_records SET timestamp=?1, favorite=?2, char_count=?3, duration_sec=?4, is_empty=?5, app_id=?6, app_name=?7, audio_file_path=?8, raw_json=?9 WHERE id=?10",
            params![timestamp, favorite as i32, char_count, duration_sec, is_empty as i32, app_id, app_name, audio_file_path, new_json, id],
        )?;

        Ok(())
    }

    pub fn history_delete(&self, id: &str) -> SqlResult<()> {
        let db = self.db.lock().unwrap();

        let list_order: Option<i64> = db
            .query_row(
                "SELECT list_order FROM history_records WHERE id = ?1",
                params![id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(list_order) = list_order else {
            return Ok(());
        };

        db.execute("DELETE FROM history_records WHERE id = ?1", params![id])?;
        db.execute(
            "UPDATE history_records SET list_order = list_order - 1 WHERE list_order > ?1",
            params![list_order],
        )?;
        Ok(())
    }

    /// Deletes every history record in one transaction, including favorites.
    ///
    /// Usage statistics live in `usage_events` and are not touched. The audio
    /// file paths are returned so the command layer can remove the recordings
    /// from disk, which storage must not do itself.
    pub fn history_clear(&self) -> SqlResult<HistoryClearSummary> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;

        let rows: Vec<(Option<String>, String)> = {
            let mut stmt = tx.prepare("SELECT audio_file_path, raw_json FROM history_records")?;
            let mapped = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
            mapped.collect::<Result<Vec<_>, _>>()?
        };

        let mut audio_file_paths = Vec::new();
        for (column_audio_path, raw_json) in &rows {
            // raw_json is the record the UI works with; it stays authoritative
            // when a backup restore filled the JSON but not the column.
            let json_audio_path = serde_json::from_str::<Value>(raw_json).ok().and_then(|v| {
                v.get("audioFilePath")
                    .and_then(|p| p.as_str())
                    .map(str::to_string)
            });
            if let Some(audio_path) = json_audio_path.or_else(|| column_audio_path.clone()) {
                if !audio_path.is_empty() {
                    audio_file_paths.push(audio_path);
                }
            }
        }

        tx.execute("DELETE FROM history_records", [])?;
        tx.commit()?;

        Ok(HistoryClearSummary { audio_file_paths })
    }

    pub fn history_set_favorite(&self, id: &str, favorite: bool) -> SqlResult<()> {
        self.history_update(id, &serde_json::json!({ "favorite": favorite }))
    }

    // ─── Collections ───

    pub fn export_collection(&self, key: &str) -> SqlResult<Value> {
        let table = collection_table(key).ok_or(rusqlite::Error::InvalidParameterName(
            "unknown collection".into(),
        ))?;
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(&format!(
            "SELECT raw_json FROM {} ORDER BY list_order ASC",
            table
        ))?;
        let rows = stmt.query_map([], |row| {
            let s: String = row.get(0)?;
            Ok(s)
        })?;

        let rows: Vec<String> = rows.collect::<SqlResult<Vec<_>>>()?;
        let items = rows
            .into_iter()
            .enumerate()
            .map(|(index, json_str)| {
                serde_json::from_str(&json_str).map_err(|error| {
                    json_conversion_error(format!("collection '{key}' row {index}"), error)
                })
            })
            .collect::<SqlResult<Vec<Value>>>()?;

        Ok(Value::Array(items))
    }

    fn replace_collection_on(db: &Connection, key: &str, items: &[Value]) -> SqlResult<()> {
        let table = collection_table(key).ok_or(rusqlite::Error::InvalidParameterName(
            "unknown collection".into(),
        ))?;

        db.execute(&format!("DELETE FROM {}", table), [])?;

        for (index, item) in items.iter().enumerate() {
            let obj = item.as_object();
            let id = obj
                .and_then(|o| o.get("id"))
                .and_then(|v| v.as_str())
                .unwrap_or("unknown")
                .to_string();
            let raw_json = serde_json::to_string(item).unwrap_or_else(|_| "{}".to_string());

            match key {
                "history" => {
                    let timestamp = obj
                        .and_then(|o| o.get("timestamp"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let favorite = obj
                        .and_then(|o| o.get("favorite"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let char_count = obj
                        .and_then(|o| o.get("charCount"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(0);
                    let duration_sec = obj
                        .and_then(|o| o.get("durationSec"))
                        .and_then(|v| v.as_f64())
                        .unwrap_or(0.0);
                    let is_empty = obj
                        .and_then(|o| o.get("isEmpty"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let app_id = obj.and_then(|o| o.get("appId")).and_then(|v| v.as_str());
                    let app_name = obj.and_then(|o| o.get("appName")).and_then(|v| v.as_str());
                    db.execute(
                        "INSERT INTO history_records (id, list_order, timestamp, favorite, char_count, duration_sec, is_empty, app_id, app_name, raw_json) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                        params![id, index as i64, timestamp, favorite as i32, char_count, duration_sec, is_empty as i32, app_id, app_name, raw_json],
                    )?;
                }
                _ => {
                    // Generic collection insert (manual_corrections, feedback_queue, prompt_presets, app_prompt_rules)
                    let name = obj.and_then(|o| o.get("name")).and_then(|v| v.as_str());
                    match table {
                        "manual_corrections" => {
                            let created_at = obj
                                .and_then(|o| o.get("createdAt"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            let history_id = obj
                                .and_then(|o| o.get("historyId"))
                                .and_then(|v| v.as_str());
                            db.execute(
                                "INSERT INTO manual_corrections (id, list_order, created_at, history_id, raw_json) VALUES (?1,?2,?3,?4,?5)",
                                params![id, index as i64, created_at, history_id, raw_json],
                            )?;
                        }
                        "feedback_queue" => {
                            let created_at = obj
                                .and_then(|o| o.get("createdAt"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            let history_id = obj
                                .and_then(|o| o.get("historyId"))
                                .and_then(|v| v.as_str());
                            let status = obj.and_then(|o| o.get("status")).and_then(|v| v.as_str());
                            db.execute(
                                "INSERT INTO feedback_queue (id, list_order, created_at, history_id, status, raw_json) VALUES (?1,?2,?3,?4,?5,?6)",
                                params![id, index as i64, created_at, history_id, status, raw_json],
                            )?;
                        }
                        "prompt_presets" => {
                            let storage_key = prompt_preset_storage_key(&id, &raw_json);
                            db.execute(
                                "INSERT INTO prompt_presets (storage_key, id, list_order, name, raw_json) VALUES (?1,?2,?3,?4,?5)",
                                params![storage_key, id, index as i64, name, raw_json],
                            )?;
                        }
                        "app_prompt_rules" => {
                            let app_id = obj.and_then(|o| o.get("appId")).and_then(|v| v.as_str());
                            let enabled = obj
                                .and_then(|o| o.get("enabled"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            let priority = obj
                                .and_then(|o| o.get("priority"))
                                .and_then(|v| v.as_i64())
                                .unwrap_or(0);
                            db.execute(
                                "INSERT INTO app_prompt_rules (id, list_order, app_id, name, enabled, priority, raw_json) VALUES (?1,?2,?3,?4,?5,?6,?7)",
                                params![id, index as i64, app_id, name, enabled as i32, priority, raw_json],
                            )?;
                        }
                        _ => {}
                    }
                }
            }
        }
        Ok(())
    }

    fn replace_collection(&self, key: &str, items: &[Value]) -> SqlResult<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        Self::replace_collection_on(&tx, key, items)?;
        tx.commit()
    }
}

impl Storage {
    /// Migrate data from the Electron app's SQLite database (one-time).
    /// Looks for sayit.db in common Electron userData paths.
    pub fn migrate_from_electron(&self) -> Result<(), String> {
        self.migrate_from_electron_with_path(Self::find_electron_db())
    }

    fn migrate_from_electron_with_path(
        &self,
        electron_db_path: Option<PathBuf>,
    ) -> Result<(), String> {
        let db = self.db.lock().unwrap();

        // Check if already migrated
        let already: bool = db
            .query_row(
                "SELECT COUNT(*) > 0 FROM db_meta WHERE key = 'electron_data_migrated_v2'",
                [],
                |row| row.get(0),
            )
            .map_err(|error| format!("Failed to check Electron data migration marker: {error}"))?;

        if already {
            log::info!("Electron data migration already done, skipping");
            return Ok(());
        }

        // Find the Electron DB
        let electron_path = match electron_db_path {
            Some(p) => p,
            None => {
                log::info!("No Electron sayit.db found, skipping migration");
                return Ok(());
            }
        };

        log::info!("Found Electron DB at: {:?}", electron_path);

        // Open the Electron DB read-only
        let src = Connection::open_with_flags(
            &electron_path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("Failed to open Electron DB: {}", e))?;

        let tx = db
            .unchecked_transaction()
            .map_err(|error| format!("Failed to start Electron data migration: {error}"))?;

        // Migrate every table and usage data in one transaction. Any error
        // drops the transaction before commit, rolling back the whole import.
        let mut migrated_counts: Vec<(String, usize)> = Vec::new();

        // 1. app_settings
        let count = Self::migrate_table_settings(&src, &tx)
            .map_err(|error| format!("Failed to migrate Electron table app_settings: {error}"))?;
        migrated_counts.push(("app_settings".into(), count));

        // 2. history_records
        let count = Self::migrate_table_generic(
            &src,
            &tx,
            "history_records",
            "id, list_order, timestamp, favorite, char_count, duration_sec, is_empty, app_id, app_name, audio_file_path, raw_json",
        )
        .map_err(|error| format!("Failed to migrate Electron table history_records: {error}"))?;
        migrated_counts.push(("history_records".into(), count));

        // 3. manual_corrections
        let count = Self::migrate_table_generic(
            &src,
            &tx,
            "manual_corrections",
            "id, list_order, created_at, history_id, raw_json",
        )
        .map_err(|error| format!("Failed to migrate Electron table manual_corrections: {error}"))?;
        migrated_counts.push(("manual_corrections".into(), count));

        // 4. feedback_queue
        let count = Self::migrate_table_generic(
            &src,
            &tx,
            "feedback_queue",
            "id, list_order, created_at, history_id, status, raw_json",
        )
        .map_err(|error| format!("Failed to migrate Electron table feedback_queue: {error}"))?;
        migrated_counts.push(("feedback_queue".into(), count));

        // 5. prompt_presets
        let count = Self::migrate_prompt_presets(&src, &tx)
            .map_err(|error| format!("Failed to migrate Electron table prompt_presets: {error}"))?;
        migrated_counts.push(("prompt_presets".into(), count));

        // 6. app_prompt_rules
        let count = Self::migrate_table_generic(
            &src,
            &tx,
            "app_prompt_rules",
            "id, list_order, app_id, name, enabled, priority, raw_json",
        )
        .map_err(|error| format!("Failed to migrate Electron table app_prompt_rules: {error}"))?;
        migrated_counts.push(("app_prompt_rules".into(), count));

        // 7. Usage events: migration 5 ran on the empty database before this
        //    import, so seed them from the imported history and counters now.
        usage::rebuild_usage_from_legacy(&tx)
            .map_err(|error| format!("Failed to rebuild imported usage statistics: {error}"))?;

        // Mark migration as done
        let now = chrono::Utc::now().timestamp_millis();
        let markers = [
            ("electron_data_migrated_v2", now.to_string()),
            ("electron_data_migrated_at", now.to_string()),
            (
                "electron_db_source_path",
                serde_json::json!(electron_path.to_string_lossy()).to_string(),
            ),
        ];
        for (key, value_json) in markers {
            tx.execute(
                "INSERT INTO db_meta (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![key, value_json, now],
            )
            .map_err(|error| format!("Failed to write Electron migration marker {key}: {error}"))?;
        }

        tx.commit()
            .map_err(|error| format!("Failed to commit Electron data migration: {error}"))?;

        log::info!("Electron data migration complete: {:?}", migrated_counts);
        Ok(())
    }

    fn find_electron_db() -> Option<PathBuf> {
        // Electron's app.getPath('userData') on Windows is typically:
        //   C:\Users\<user>\AppData\Roaming\<appName>
        // The app name could be "SayIt", "sayit", or "SayIt-dev"
        let roaming = dirs::data_dir()?; // AppData\Roaming
        let candidates = [
            roaming.join("SayIt").join("sayit.db"),
            roaming.join("sayit").join("sayit.db"),
            roaming.join("SayIt-dev").join("sayit.db"),
            roaming.join("sayit-dev").join("sayit.db"),
        ];

        for path in &candidates {
            if path.exists() {
                return Some(path.clone());
            }
        }
        None
    }

    fn source_table_exists(src: &Connection, table: &str) -> SqlResult<bool> {
        src.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1
            )",
            params![table],
            |row| row.get(0),
        )
    }

    fn migrate_table_settings(src: &Connection, dst: &Connection) -> SqlResult<usize> {
        if !Self::source_table_exists(src, "app_settings")? {
            log::info!("Electron source table app_settings absent, skipping");
            return Ok(0);
        }

        let mut stmt = src.prepare("SELECT key, value_json, updated_at FROM app_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;

        let mut count = 0usize;
        for row in rows {
            let (key, value_json, updated_at) = row?;
            // Always overwrite: Electron data takes priority over seed defaults
            dst.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![key, value_json, updated_at],
            )?;
            count += 1;
        }
        Ok(count)
    }

    fn migrate_table_generic(
        src: &Connection,
        dst: &Connection,
        table: &str,
        columns: &str,
    ) -> SqlResult<usize> {
        if !Self::source_table_exists(src, table)? {
            log::info!("Electron source table {} absent, skipping", table);
            return Ok(0);
        }

        let dst_count: i64 =
            dst.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                row.get(0)
            })?;
        if dst_count > 0 {
            return Self::skip_non_empty_destination(src, table, dst_count);
        }

        let select_sql = format!("SELECT {} FROM {} ORDER BY list_order ASC", columns, table);
        let mut stmt = src.prepare(&select_sql)?;

        let col_count = columns.split(',').count();
        let placeholders: Vec<String> = (1..=col_count).map(|i| format!("?{}", i)).collect();
        let insert_sql = format!(
            "INSERT INTO {} ({}) VALUES ({})",
            table,
            columns,
            placeholders.join(", ")
        );

        let rows = stmt.query_map([], |row| {
            let mut values: Vec<rusqlite::types::Value> = Vec::with_capacity(col_count);
            for i in 0..col_count {
                values.push(row.get(i)?);
            }
            Ok(values)
        })?;

        let mut count = 0usize;
        for row in rows {
            let row = row?;
            let params: Vec<&dyn rusqlite::types::ToSql> = row
                .iter()
                .map(|v| v as &dyn rusqlite::types::ToSql)
                .collect();
            dst.execute(&insert_sql, params.as_slice())?;
            count += 1;
        }
        Ok(count)
    }

    /// Local rows written after a failed attempt must not make a skip look like
    /// a finished import, so a non-empty destination is only skipped when the
    /// source is empty too.
    fn skip_non_empty_destination(
        src: &Connection,
        table: &str,
        dst_count: i64,
    ) -> SqlResult<usize> {
        let src_count: i64 =
            src.query_row(&format!("SELECT COUNT(*) FROM {}", table), [], |row| {
                row.get(0)
            })?;
        if src_count > 0 {
            return Err(rusqlite::Error::ToSqlConversionFailure(Box::new(
                std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!(
                        "{table} already has {dst_count} local rows while the Electron source has {src_count}; refusing to skip them, the migration stays pending"
                    ),
                ),
            )));
        }
        log::info!("Table {} already has {} rows, skipping", table, dst_count);
        Ok(0)
    }

    fn migrate_prompt_presets(src: &Connection, dst: &Connection) -> SqlResult<usize> {
        if !Self::source_table_exists(src, "prompt_presets")? {
            log::info!("Electron source table prompt_presets absent, skipping");
            return Ok(0);
        }

        let dst_count: i64 =
            dst.query_row("SELECT COUNT(*) FROM prompt_presets", [], |row| row.get(0))?;
        if dst_count > 0 {
            return Self::skip_non_empty_destination(src, "prompt_presets", dst_count);
        }

        let mut stmt = src.prepare(
            "SELECT id, list_order, name, raw_json FROM prompt_presets ORDER BY list_order ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, String>(3)?,
            ))
        })?;

        let mut count = 0usize;
        for row in rows {
            let (id, list_order, name, raw_json) = row?;
            let storage_key = prompt_preset_storage_key(&id, &raw_json);
            dst.execute(
                "INSERT INTO prompt_presets (storage_key, id, list_order, name, raw_json) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![storage_key, id, list_order, name, raw_json],
            )?;
            count += 1;
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_db_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sayit-{name}-{}.db", uuid::Uuid::new_v4()))
    }

    fn create_electron_source_schema(connection: &Connection) {
        connection
            .execute_batch(
                "CREATE TABLE app_settings (
                    key TEXT PRIMARY KEY,
                    value_json TEXT NOT NULL,
                    updated_at INTEGER NOT NULL
                );
                CREATE TABLE history_records (
                    id TEXT NOT NULL,
                    list_order INTEGER NOT NULL,
                    timestamp INTEGER NOT NULL DEFAULT 0,
                    favorite INTEGER NOT NULL DEFAULT 0,
                    char_count INTEGER NOT NULL DEFAULT 0,
                    duration_sec REAL NOT NULL DEFAULT 0,
                    is_empty INTEGER NOT NULL DEFAULT 0,
                    app_id TEXT,
                    app_name TEXT,
                    audio_file_path TEXT,
                    raw_json TEXT NOT NULL
                );
                CREATE TABLE manual_corrections (
                    id TEXT NOT NULL,
                    list_order INTEGER NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT 0,
                    history_id TEXT,
                    raw_json TEXT NOT NULL
                );
                CREATE TABLE feedback_queue (
                    id TEXT NOT NULL,
                    list_order INTEGER NOT NULL,
                    created_at INTEGER NOT NULL DEFAULT 0,
                    history_id TEXT,
                    status TEXT,
                    raw_json TEXT NOT NULL
                );
                CREATE TABLE prompt_presets (
                    id TEXT NOT NULL,
                    list_order INTEGER NOT NULL,
                    name TEXT,
                    raw_json TEXT NOT NULL
                );
                CREATE TABLE app_prompt_rules (
                    id TEXT NOT NULL,
                    list_order INTEGER NOT NULL,
                    app_id TEXT,
                    name TEXT,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    priority INTEGER NOT NULL DEFAULT 0,
                    raw_json TEXT NOT NULL
                );",
            )
            .unwrap();
    }

    fn create_electron_source_db(name: &str) -> PathBuf {
        let path = test_db_path(name);
        let connection = Connection::open(&path).unwrap();
        create_electron_source_schema(&connection);
        drop(connection);
        path
    }

    fn electron_marker_count(storage: &Storage) -> i64 {
        storage
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM db_meta WHERE key IN (
                    'electron_data_migrated_v2',
                    'electron_data_migrated_at',
                    'electron_db_source_path'
                )",
                [],
                |row| row.get(0),
            )
            .unwrap()
    }

    #[test]
    fn electron_migration_rolls_back_duplicate_source_and_retries_idempotently() {
        let source_path = create_electron_source_db("electron-duplicate-history");
        {
            let source = Connection::open(&source_path).unwrap();
            source
                .execute_batch(
                    r#"INSERT INTO app_settings (key, value_json, updated_at) VALUES
                        ('cloudAi.model', '"source-model"', 1),
                        ('stats', '{"totalChars":7,"totalDurationSec":3.0}', 1),
                        ('userStats', '{"totalSessions":2}', 1);
                    INSERT INTO history_records
                        (id, list_order, timestamp, char_count, duration_sec, raw_json)
                        VALUES
                        ('duplicate-history', 0, 1000, 3, 1.0, '{"id":"duplicate-history"}'),
                        ('duplicate-history', 1, 2000, 4, 2.0, '{"id":"duplicate-history"}');"#,
                )
                .unwrap();
        }

        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set("cloudAi.model", &serde_json::json!("destination-model"))
            .unwrap();

        let error = storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap_err();
        assert!(
            error.contains("history_records"),
            "unexpected error: {error}"
        );
        assert_eq!(storage.get("cloudAi.model", None), "destination-model");
        assert_eq!(storage.history_count(None, false).unwrap(), 0);
        assert_eq!(storage.usage_summary(None).unwrap().takes, 0);
        assert_eq!(electron_marker_count(&storage), 0);

        let retry_error = storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap_err();
        assert!(
            retry_error.contains("history_records"),
            "unexpected retry error: {retry_error}"
        );
        assert_eq!(storage.history_count(None, false).unwrap(), 0);
        assert_eq!(electron_marker_count(&storage), 0);

        {
            let source = Connection::open(&source_path).unwrap();
            source
                .execute(
                    "UPDATE history_records SET id = ?1, raw_json = ?2 WHERE list_order = 1",
                    params!["history-2", r#"{"id":"history-2"}"#],
                )
                .unwrap();
        }

        storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap();
        assert_eq!(storage.get("cloudAi.model", None), "source-model");
        assert_eq!(storage.history_count(None, false).unwrap(), 2);
        assert_eq!(storage.usage_summary(None).unwrap().takes, 2);
        assert_eq!(storage.usage_summary(None).unwrap().total_chars, 7);
        assert_eq!(electron_marker_count(&storage), 3);

        storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap();
        assert_eq!(storage.history_count(None, false).unwrap(), 2);
        assert_eq!(storage.usage_summary(None).unwrap().takes, 2);
        assert_eq!(electron_marker_count(&storage), 3);

        drop(storage);
        let _ = fs::remove_file(source_path);
    }

    #[test]
    fn electron_migration_skips_absent_source_tables_and_marks_success() {
        let source_path = create_electron_source_db("electron-absent-table");
        {
            let source = Connection::open(&source_path).unwrap();
            source
                .execute_batch(
                    r#"DROP TABLE manual_corrections;
                     DROP TABLE feedback_queue;
                     DROP TABLE prompt_presets;
                     DROP TABLE app_prompt_rules;
                     INSERT INTO app_settings (key, value_json, updated_at) VALUES
                         ('cloudAi.model', '"source-model"', 1),
                         ('stats', '{"totalChars":3,"totalDurationSec":1.0}', 1),
                         ('userStats', '{"totalSessions":1}', 1);
                     INSERT INTO history_records
                         (id, list_order, timestamp, char_count, duration_sec, raw_json)
                         VALUES ('history-1', 0, 1000, 3, 1.0, '{"id":"history-1"}');"#,
                )
                .unwrap();
        }

        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap();

        assert_eq!(storage.get("cloudAi.model", None), "source-model");
        assert_eq!(storage.history_count(None, false).unwrap(), 1);
        assert_eq!(storage.usage_summary(None).unwrap().takes, 1);
        assert_eq!(electron_marker_count(&storage), 3);

        drop(storage);
        let _ = fs::remove_file(source_path);
    }

    #[test]
    fn electron_migration_refuses_retry_when_local_rows_block_a_pending_import() {
        let source_path = create_electron_source_db("electron-local-rows-retry");
        {
            let source = Connection::open(&source_path).unwrap();
            source
                .execute_batch(
                    r#"INSERT INTO history_records
                        (id, list_order, timestamp, char_count, duration_sec, raw_json)
                        VALUES ('electron-history', 0, 1000, 3, 1.0, '{"id":"electron-history"}');
                       INSERT INTO manual_corrections
                        (id, list_order, created_at, raw_json)
                        VALUES
                        ('duplicate-correction', 0, 1, '{"id":"duplicate-correction"}'),
                        ('duplicate-correction', 1, 2, '{"id":"duplicate-correction"}');"#,
                )
                .unwrap();
        }

        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let error = storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap_err();
        assert!(
            error.contains("manual_corrections"),
            "unexpected error: {error}"
        );
        assert_eq!(electron_marker_count(&storage), 0);
        assert_eq!(storage.history_count(None, false).unwrap(), 0);

        storage
            .history_add(&serde_json::json!({
                "id": "local-history",
                "timestamp": 5,
                "charCount": 2
            }))
            .unwrap();

        {
            let source = Connection::open(&source_path).unwrap();
            source
                .execute("DELETE FROM manual_corrections WHERE list_order = 1", [])
                .unwrap();
        }

        let retry_error = storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap_err();
        assert!(
            retry_error.contains("history_records"),
            "unexpected retry error: {retry_error}"
        );
        assert_eq!(electron_marker_count(&storage), 0);
        assert_eq!(storage.history_count(None, false).unwrap(), 1);

        drop(storage);
        let _ = fs::remove_file(source_path);
    }

    #[test]
    fn electron_migration_refuses_to_skip_source_presets_behind_local_ones() {
        let source_path = create_electron_source_db("electron-local-presets");
        {
            let source = Connection::open(&source_path).unwrap();
            source
                .execute(
                    "INSERT INTO prompt_presets (id, list_order, name, raw_json) VALUES (?1, 0, ?2, ?3)",
                    params![
                        "electron-preset",
                        "Electron",
                        r#"{"id":"electron-preset","name":"Electron","systemPrompt":"e"}"#
                    ],
                )
                .unwrap();
        }

        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let local =
            serde_json::json!([{ "id": "local-preset", "name": "Local", "systemPrompt": "l" }]);
        storage.set("promptPresets", &local).unwrap();

        let error = storage
            .migrate_from_electron_with_path(Some(source_path.clone()))
            .unwrap_err();
        assert!(
            error.contains("prompt_presets"),
            "unexpected error: {error}"
        );
        assert_eq!(electron_marker_count(&storage), 0);
        assert_eq!(storage.get("promptPresets", None), local);

        drop(storage);
        let _ = fs::remove_file(source_path);
    }

    #[test]
    fn app_settings_batch_rolls_back_all_ai_keys_on_runtime_write_failure() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let original = serde_json::json!({
            "cloudAi.profiles": [{ "id": "p-old" }],
            "cloudAi.activeProfileId": "p-old",
            "cloudAi.provider": "old-provider",
            "cloudAi.apiUrl": "https://old.example.test/v1",
            "cloudAi.apiKey": "old-key",
            "cloudAi.model": "old-model",
            "cloudAi.reasoningEffort": "low",
            "cloudAi.serviceTier": "fast"
        });
        let replacement = serde_json::json!({
            "cloudAi.profiles": [{ "id": "p-new" }],
            "cloudAi.activeProfileId": "p-new",
            "cloudAi.provider": "new-provider",
            "cloudAi.apiUrl": "https://new.example.test/v1",
            "cloudAi.apiKey": "new-key",
            "cloudAi.model": "new-model",
            "cloudAi.reasoningEffort": "high",
            "cloudAi.serviceTier": ""
        });
        for (key, value) in original.as_object().unwrap() {
            storage.set(key, value).unwrap();
        }
        // Fail only after the new selection was written inside the transaction,
        // proving that earlier writes are rolled back rather than never attempted.
        storage.db.lock().unwrap().execute_batch(
            "CREATE TRIGGER fail_ai_runtime_write BEFORE UPDATE ON app_settings
             WHEN NEW.key = 'cloudAi.provider'
              AND (SELECT value_json FROM app_settings WHERE key = 'cloudAi.activeProfileId') = '\"p-new\"'
             BEGIN SELECT RAISE(ABORT, 'injected AI runtime write failure'); END;"
        ).unwrap();

        let error = storage
            .set_app_settings(replacement.as_object().unwrap())
            .unwrap_err();
        assert!(
            error
                .to_string()
                .contains("injected AI runtime write failure")
        );
        for (key, value) in original.as_object().unwrap() {
            assert_eq!(storage.get(key, None), *value, "changed setting: {key}");
        }

        storage
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_ai_runtime_write")
            .unwrap();
        storage
            .set_app_settings(replacement.as_object().unwrap())
            .unwrap();
        for (key, value) in replacement.as_object().unwrap() {
            assert_eq!(storage.get(key, None), *value);
        }
    }

    #[test]
    fn app_settings_batch_rejects_collection_keys_without_changing_stored_data() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set("cloudAi.model", &serde_json::json!("original-model"))
            .unwrap();
        let before = storage.export_app_settings(&[]).unwrap();
        for key in COLLECTION_KEYS {
            let collection = storage.get(key, None);
            let mut settings = serde_json::Map::new();
            settings.insert("cloudAi.model".to_owned(), serde_json::json!("new-model"));
            settings.insert((*key).to_owned(), serde_json::json!([]));

            assert!(storage.set_app_settings(&settings).is_err());
            assert_eq!(storage.export_app_settings(&[]).unwrap(), before);
            assert_eq!(storage.get(key, None), collection);
        }
    }

    #[test]
    fn prompt_storage_key_keeps_legacy_overrides_in_chinese() {
        assert_eq!(
            prompt_preset_storage_key("intent", r#"{"id":"intent"}"#),
            "builtin:intent:zh-CN"
        );
        assert_eq!(
            prompt_preset_storage_key("intent", r#"{"builtinPromptLanguage":"uk"}"#),
            "builtin:intent:uk"
        );
        assert_eq!(
            prompt_preset_storage_key("intent", r#"{"builtinPromptLanguage":"fr"}"#),
            "builtin:intent:zh-CN"
        );
        assert_eq!(
            prompt_preset_storage_key("custom", r#"{"id":"custom"}"#),
            "custom:custom"
        );
    }

    #[test]
    fn prompt_preset_migration_preserves_languages_and_is_idempotent() {
        let path = test_db_path("prompt-migration");
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch(
                "CREATE TABLE schema_migrations (
                    version INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    applied_at INTEGER NOT NULL
                )",
            )
            .unwrap();
            db.execute_batch(include_str!("migration_001.sql")).unwrap();
            db.execute("DROP TABLE prompt_presets", []).unwrap();
            db.execute_batch(
                "CREATE TABLE prompt_presets (
                    id TEXT PRIMARY KEY,
                    list_order INTEGER NOT NULL,
                    name TEXT,
                    raw_json TEXT NOT NULL
                )",
            )
            .unwrap();
            db.execute("INSERT INTO prompt_presets (id, list_order, name, raw_json) VALUES ('intent', 0, 'legacy', ?1)",
                [r#"{"id":"intent","systemPrompt":"legacy"}"#]).unwrap();
            db.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'init', 0)",
                [],
            )
            .unwrap();
            db.execute(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (2, 'audio', 0)",
                [],
            )
            .unwrap();
        }

        let storage = Storage::new(path.clone()).unwrap();
        storage
            .set(
                "promptPresets",
                &serde_json::json!([
                    { "id": "intent", "systemPrompt": "zh", "builtinPromptLanguage": "zh-CN" },
                    { "id": "intent", "systemPrompt": "uk", "builtinPromptLanguage": "uk" },
                ]),
            )
            .unwrap();
        let value = storage.get("promptPresets", None);
        assert_eq!(value.as_array().unwrap().len(), 2);
        assert_eq!(value[0]["id"], "intent");
        assert!(value[0].get("storage_key").is_none());

        drop(storage);
        let storage = Storage::new(path.clone()).unwrap();
        assert_eq!(
            storage.get("promptPresets", None).as_array().unwrap().len(),
            2
        );
        drop(storage);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn prompt_preset_replace_rolls_back_on_duplicate_key() {
        let path = test_db_path("prompt-rollback");
        let storage = Storage::new(path.clone()).unwrap();
        let original = serde_json::json!([{ "id": "intent", "systemPrompt": "original", "builtinPromptLanguage": "uk" }]);
        storage.set("promptPresets", &original).unwrap();
        let invalid = serde_json::json!([
            { "id": "intent", "systemPrompt": "first", "builtinPromptLanguage": "uk" },
            { "id": "intent", "systemPrompt": "second", "builtinPromptLanguage": "uk" },
        ]);
        assert!(storage.set("promptPresets", &invalid).is_err());
        assert_eq!(storage.get("promptPresets", None), original);
        drop(storage);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn history_replace_rolls_back_on_duplicate_id() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let original = serde_json::json!([{
            "id": "history-original",
            "timestamp": 1,
            "charCount": 3,
        }]);
        storage.set("history", &original).unwrap();

        let invalid = serde_json::json!([
            { "id": "duplicate-history", "timestamp": 2 },
            { "id": "duplicate-history", "timestamp": 3 },
        ]);
        assert!(storage.set("history", &invalid).is_err());

        assert_eq!(
            storage.history_list(None, false, None, None).unwrap(),
            original.as_array().unwrap().to_vec()
        );
    }

    #[test]
    fn full_restore_transaction_rolls_back_duplicate_history() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let original_settings = serde_json::json!({
            "cloudAi.model": "original-model",
        });
        for (key, value) in original_settings.as_object().unwrap() {
            storage.set(key, value).unwrap();
        }
        let original_history = serde_json::json!([{
            "id": "original-history",
            "timestamp": 1,
            "charCount": 3,
        }]);
        storage.set("history", &original_history).unwrap();

        let replacement_settings = serde_json::json!({
            "cloudAi.model": "replacement-model",
        });
        let replacement_history = vec![
            serde_json::json!({ "id": "duplicate-history", "timestamp": 2 }),
            serde_json::json!({ "id": "duplicate-history", "timestamp": 3 }),
        ];

        assert!(
            storage
                .restore_full_transaction(
                    replacement_settings.as_object().unwrap(),
                    &[],
                    None,
                    None,
                    Some(&replacement_history),
                    None,
                    None,
                    None,
                )
                .is_err()
        );

        assert_eq!(
            storage.export_app_settings(&[]).unwrap()["cloudAi.model"],
            "original-model"
        );
        assert_eq!(storage.get("history", None), original_history);
    }

    #[test]
    fn full_restore_transaction_rolls_back_when_usage_fails_late() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set("cloudAi.model", &serde_json::json!("original-model"))
            .unwrap();
        let original_history = serde_json::json!([{
            "id": "original-history",
            "timestamp": 1,
            "charCount": 3,
        }]);
        storage.set("history", &original_history).unwrap();
        storage
            .usage_record(
                0,
                &UsageEventInput {
                    char_count: 5,
                    duration_sec: 1.0,
                    app_id: None,
                    work_mode: None,
                    prompt_preset_id: None,
                },
            )
            .unwrap();
        let original_usage = storage.usage_backup().unwrap();
        storage
            .db
            .lock()
            .unwrap()
            .execute_batch(
                "CREATE TRIGGER fail_restore_usage BEFORE INSERT ON usage_events
                 BEGIN SELECT RAISE(ABORT, 'injected usage restore failure'); END;",
            )
            .unwrap();

        let replacement_settings = serde_json::json!({
            "cloudAi.model": "replacement-model",
        });
        let replacement_history =
            vec![serde_json::json!({ "id": "replacement-history", "timestamp": 2 })];
        let error = storage
            .restore_full_transaction(
                replacement_settings.as_object().unwrap(),
                &[],
                None,
                None,
                Some(&replacement_history),
                None,
                None,
                Some(&original_usage),
            )
            .unwrap_err();

        assert!(error.to_string().contains("injected usage restore failure"));
        assert_eq!(
            storage.get("cloudAi.model", None),
            serde_json::json!("original-model")
        );
        assert_eq!(storage.get("history", None), original_history);
        assert_eq!(storage.usage_backup().unwrap(), original_usage);

        storage
            .db
            .lock()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_restore_usage")
            .unwrap();
    }

    #[test]
    fn history_list_returns_error_for_invalid_json() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO history_records (id, list_order, raw_json) VALUES (?1, ?2, ?3)",
                params!["broken-history", 0, "{not json"],
            )
            .unwrap();

        let error = storage.history_list(None, false, None, None).unwrap_err();
        assert!(error.to_string().contains("history row 0"));
    }

    #[test]
    fn export_collection_returns_valid_values_and_rejects_invalid_json() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let expected = serde_json::json!([{
            "id": "correction-1",
            "createdAt": 42,
            "historyId": "history-1",
        }]);
        storage.set("manualCorrections", &expected).unwrap();

        assert_eq!(
            storage.export_collection("manualCorrections").unwrap(),
            expected
        );

        storage
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO manual_corrections (id, list_order, raw_json) VALUES (?1, ?2, ?3)",
                params!["broken-correction", 1, "{not json"],
            )
            .unwrap();

        let error = storage.export_collection("manualCorrections").unwrap_err();
        assert!(error.to_string().contains("manualCorrections"));
        assert!(error.to_string().contains("row 1"));
    }

    #[test]
    fn export_app_settings_returns_valid_values_and_rejects_invalid_json() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set("cloudAi.model", &serde_json::json!("valid-model"))
            .unwrap();

        let exported = storage.export_app_settings(&[]).unwrap();
        assert_eq!(exported["cloudAi.model"], "valid-model");

        storage
            .db
            .lock()
            .unwrap()
            .execute(
                "UPDATE app_settings SET value_json = ?1 WHERE key = ?2",
                params!["{not json", "cloudAi.model"],
            )
            .unwrap();

        let error = storage.export_app_settings(&[]).unwrap_err();
        assert!(error.to_string().contains("cloudAi.model"));
    }

    #[test]
    fn history_count_returns_honest_counts() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        assert_eq!(storage.history_count(None, false).unwrap(), 0);

        storage
            .history_add(&serde_json::json!({
                "id": "count-1",
                "asrText": "alpha",
                "favorite": false,
            }))
            .unwrap();
        storage
            .history_add(&serde_json::json!({
                "id": "count-2",
                "asrText": "beta",
                "favorite": true,
            }))
            .unwrap();

        assert_eq!(storage.history_count(None, false).unwrap(), 2);
        assert_eq!(storage.history_count(Some("beta"), false).unwrap(), 1);
        assert_eq!(storage.history_count(None, true).unwrap(), 1);
    }

    #[test]
    fn history_clear_removes_all_records_including_favorites_and_returns_audio_paths() {
        let path = test_db_path("history-clear");
        let storage = Storage::new(path.clone()).unwrap();

        storage
            .history_add(&serde_json::json!({
                "id": "favorite-1",
                "timestamp": 1,
                "charCount": 5,
                "durationSec": 1.5,
                "favorite": true,
                "audioFilePath": "C:/audio/favorite-1.wav",
            }))
            .unwrap();
        storage
            .history_add(&serde_json::json!({
                "id": "empty-1",
                "timestamp": 2,
                "charCount": 0,
                "durationSec": 2.5,
                "isEmpty": true,
            }))
            .unwrap();
        storage
            .history_add(&serde_json::json!({
                "id": "plain-1",
                "timestamp": 3,
                "charCount": 7,
                "durationSec": 3.0,
                "audioFilePath": "C:/audio/plain-1.wav",
            }))
            .unwrap();

        let summary = storage.history_clear().unwrap();

        let mut audio_file_paths = summary.audio_file_paths;
        audio_file_paths.sort();
        assert_eq!(
            audio_file_paths,
            vec![
                "C:/audio/favorite-1.wav".to_string(),
                "C:/audio/plain-1.wav".to_string()
            ]
        );
        assert!(
            storage
                .history_list(None, false, None, None)
                .unwrap()
                .is_empty()
        );
        assert_eq!(storage.history_count(None, false).unwrap(), 0);

        drop(storage);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn history_clear_on_empty_history_is_a_noop() {
        let path = test_db_path("history-clear-empty");
        let storage = Storage::new(path.clone()).unwrap();

        let summary = storage.history_clear().unwrap();

        assert!(summary.audio_file_paths.is_empty());

        drop(storage);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn history_clear_collects_audio_paths_from_records_restored_without_column_backfill() {
        let path = test_db_path("history-clear-restored-audio");
        let storage = Storage::new(path.clone()).unwrap();
        // A full-backup restore writes history through the collection path,
        // which fills raw_json but leaves the audio_file_path column empty.
        storage
            .set(
                "history",
                &serde_json::json!([{
                    "id": "restored-1",
                    "timestamp": 1,
                    "charCount": 3,
                    "durationSec": 1.0,
                    "audioFilePath": "C:/audio/restored-1.wav",
                }]),
            )
            .unwrap();

        let summary = storage.history_clear().unwrap();

        assert_eq!(
            summary.audio_file_paths,
            vec!["C:/audio/restored-1.wav".to_string()]
        );
        assert!(
            storage
                .history_list(None, false, None, None)
                .unwrap()
                .is_empty()
        );

        drop(storage);
        let _ = fs::remove_file(path);
    }

    #[test]
    fn history_update_persists_explicit_null_ai_metadata_and_preserves_other_fields() {
        let path = test_db_path("history-null-ai-metadata");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .history_add(&serde_json::json!({
                "id": "null-ai-metadata",
                "timestamp": 42,
                "asrText": "recognized words",
                "llmText": "polished words",
                "charCount": 14,
                "durationSec": 2.5,
                "aiSource": "custom",
                "aiStatus": "applied",
                "aiProvider": "provider-a",
                "aiModel": "model-a",
            }))
            .unwrap();

        storage
            .history_update(
                "null-ai-metadata",
                &serde_json::json!({
                    "aiProvider": null,
                    "aiModel": null,
                    "aiSource": "none",
                    "aiStatus": "skipped",
                }),
            )
            .unwrap();
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let record = storage
            .history_list(None, false, None, None)
            .unwrap()
            .remove(0);

        assert_eq!(record.get("aiProvider"), Some(&Value::Null));
        assert_eq!(record.get("aiModel"), Some(&Value::Null));
        assert_eq!(record["aiSource"], "none");
        assert_eq!(record["aiStatus"], "skipped");
        assert_eq!(record["id"], "null-ai-metadata");
        assert_eq!(record["asrText"], "recognized words");
        assert_eq!(record["llmText"], "polished words");
        assert_eq!(record["timestamp"], 42);
        assert_eq!(record["charCount"], 14);
        assert_eq!(record["durationSec"], 2.5);

        drop(storage);
        let _ = fs::remove_file(path);
    }

    /// A per-test temporary directory. Pre-migration snapshots embed a
    /// timestamp and a UUID in their names, so tests that produce them keep
    /// the database and its snapshots in one owned directory and remove it
    /// whole once every handle is closed.
    fn test_db_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sayit-{name}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The automatic pre-migration snapshot databases written directly beside
    /// a database, sorted by name. Sidecar files of a snapshot (`-wal`,
    /// `-shm`, `-journal`) are not snapshots themselves.
    fn snapshot_files(dir: &Path) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| {
                path.file_name()
                    .map(|name| {
                        let name = name.to_string_lossy();
                        name.contains("-before-migration-") && name.ends_with(".sqlite3")
                    })
                    .unwrap_or(false)
            })
            .collect();
        files.sort();
        files
    }

    fn read_migration_versions(connection: &Connection) -> Vec<i64> {
        let mut statement = connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
            .unwrap();
        let versions = statement
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<SqlResult<Vec<i64>>>()
            .unwrap();
        versions
    }

    fn read_setting_value(connection: &Connection, key: &str) -> Option<String> {
        connection
            .query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .unwrap()
    }

    /// A real on-disk database in an older shape: schema version 1 recorded,
    /// legacy counters in `app_settings`, no usage schema. The returned
    /// connection must stay open while `Storage::new` runs: auto-checkpoint is
    /// off, so everything written here is still only in the `-wal` file and
    /// reaches a copy solely through the backup API.
    fn legacy_database_fixture(path: &Path) -> Connection {
        let connection = Connection::open(path).unwrap();
        connection
            .execute_batch("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;")
            .unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                     version INTEGER PRIMARY KEY,
                     name TEXT NOT NULL,
                     applied_at INTEGER NOT NULL
                 );",
            )
            .unwrap();
        connection
            .execute_batch(include_str!("migration_001.sql"))
            .unwrap();
        connection
            .execute_batch(
                "INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'init-sqlite-storage', 0);
                 INSERT INTO app_settings (key, value_json, updated_at) VALUES
                     ('stats', '{\"totalChars\":1234,\"totalDurationSec\":56.0}', 0),
                     ('userStats', '{\"totalSessions\":7}', 0),
                     ('walOnlySentinel', '\"committed-to-wal\"', 0);",
            )
            .unwrap();
        connection
    }

    #[test]
    fn pre_migration_snapshot_keeps_old_schema_and_wal_only_data() {
        let dir = test_db_dir("snapshot-content");
        let path = dir.join("sayit.db");
        let fixture = legacy_database_fixture(&path);

        // Every committed row, the sentinel included, is still only in the
        // WAL; a copy that misses WAL content would miss the sentinel too.
        let sentinel = b"walOnlySentinel";
        let wal_bytes = fs::read(dir.join("sayit.db-wal")).unwrap();
        assert!(
            wal_bytes
                .windows(sentinel.len())
                .any(|window| window == &sentinel[..])
        );
        let main_bytes = fs::read(&path).unwrap();
        assert!(
            !main_bytes
                .windows(sentinel.len())
                .any(|window| window == &sentinel[..])
        );

        let storage = Storage::new(path.clone()).unwrap();

        let snapshots = snapshot_files(&dir);
        assert_eq!(
            snapshots.len(),
            1,
            "pending versions 2, 3 and 5 must share one pre-migration snapshot"
        );

        let copy =
            Connection::open_with_flags(&snapshots[0], rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let quick_check: Vec<String> = {
            let mut statement = copy.prepare("PRAGMA quick_check").unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<SqlResult<Vec<String>>>()
                .unwrap()
        };
        assert_eq!(
            quick_check,
            vec!["ok".to_string()],
            "the snapshot must be a valid, readable database"
        );
        assert_eq!(
            read_migration_versions(&copy),
            vec![1],
            "the snapshot must keep the pre-migration markers"
        );
        assert!(
            !usage::usage_events_exists(&copy).unwrap(),
            "the snapshot must predate the usage schema"
        );
        assert_eq!(
            read_setting_value(&copy, "stats").as_deref(),
            Some(r#"{"totalChars":1234,"totalDurationSec":56.0}"#)
        );
        assert_eq!(
            read_setting_value(&copy, "userStats").as_deref(),
            Some(r#"{"totalSessions":7}"#)
        );
        assert_eq!(
            read_setting_value(&copy, "walOnlySentinel").as_deref(),
            Some("\"committed-to-wal\""),
            "the snapshot must include data that was still only in the WAL"
        );
        drop(copy);

        {
            let live = storage.db.lock().unwrap();
            assert_eq!(
                read_migration_versions(&live),
                vec![1, 2, 3, 5],
                "startup must still migrate the live database"
            );
        }
        let summary = storage.usage_summary(None).unwrap();
        assert_eq!((summary.takes, summary.total_chars), (7, 1234));
        assert_eq!(
            storage.get("stats", None),
            Value::Null,
            "migration 5 consumes the legacy counters"
        );

        drop(storage);
        drop(fixture);
        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn fresh_and_schema_less_databases_get_no_snapshot() {
        let dir = test_db_dir("snapshot-fresh");
        let path = dir.join("sayit.db");

        // A pre-created file with no tables is as fresh as a missing one.
        let empty_path = dir.join("pre-created.db");
        drop(Connection::open(&empty_path).unwrap());

        // `:memory:` cannot stay behind on disk; unwrap proves the startup
        // path itself does not try to snapshot it.
        drop(Storage::new(PathBuf::from(":memory:")).unwrap());
        drop(Storage::new(path.clone()).unwrap());
        drop(Storage::new(empty_path.clone()).unwrap());

        assert!(
            snapshot_files(&dir).is_empty(),
            "databases without user schema have no pre-migration state to keep"
        );
        let check = Connection::open(&empty_path).unwrap();
        assert_eq!(read_migration_versions(&check), vec![1, 2, 3, 5]);
        drop(check);

        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn reopening_a_migrated_database_without_version_four_writes_no_snapshot() {
        let dir = test_db_dir("snapshot-reopen");
        let path = dir.join("sayit.db");

        drop(Storage::new(path.clone()).unwrap());
        assert!(snapshot_files(&dir).is_empty());

        drop(Storage::new(path.clone()).unwrap());

        let check = Connection::open(&path).unwrap();
        assert_eq!(read_migration_versions(&check), vec![1, 2, 3, 5]);
        drop(check);
        assert!(
            snapshot_files(&dir).is_empty(),
            "versions 1, 2, 3 and 5 recorded is complete even though version 4 is absent"
        );

        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn a_second_pending_startup_never_overwrites_the_first_snapshot() {
        let dir = test_db_dir("snapshot-no-overwrite");
        let path = dir.join("sayit.db");
        let fixture = legacy_database_fixture(&path);

        let storage = Storage::new(path.clone()).unwrap();
        let first = snapshot_files(&dir);
        assert_eq!(first.len(), 1);
        let first_path = first[0].clone();
        let first_bytes = fs::read(&first_path).unwrap();

        // Rewind the live database to the pre-usage shape so the next startup
        // has pending work again and attempts a second snapshot.
        storage
            .db
            .lock()
            .unwrap()
            .execute_batch(
                "DROP TABLE usage_events;
                 DELETE FROM schema_migrations WHERE version = 5;",
            )
            .unwrap();
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let snapshots = snapshot_files(&dir);
        assert_eq!(
            snapshots.len(),
            2,
            "each startup with pending work writes its own snapshot"
        );
        assert!(snapshots.contains(&first_path));
        assert_eq!(
            fs::read(&first_path).unwrap(),
            first_bytes,
            "an existing snapshot must never be rewritten"
        );

        let first_copy =
            Connection::open_with_flags(&first_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert_eq!(
            read_migration_versions(&first_copy),
            vec![1],
            "the first snapshot must still hold the oldest pre-migration state"
        );
        drop(first_copy);

        drop(storage);
        drop(fixture);
        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn snapshot_refuses_to_overwrite_an_existing_file_and_reports_backup_context() {
        let dir = test_db_dir("snapshot-refuse-overwrite");
        let path = dir.join("sayit.db");
        let fixture = legacy_database_fixture(&path);
        // The source opens and reads fine, so the failure below can only come
        // from the snapshot step itself.
        let markers_before = read_migration_versions(&fixture);

        let destination = dir.join("sayit-before-migration-20000101T000000Z-taken.sqlite3");
        fs::write(&destination, b"earlier snapshot, never to be replaced").unwrap();

        let error = Storage::create_verified_snapshot(&fixture, &destination).unwrap_err();

        let message = error.to_string();
        assert!(
            message.contains("pre-migration backup"),
            "the error must say the backup failed: {message}"
        );
        assert!(
            message.contains("taken.sqlite3"),
            "the error must name the failed destination: {message}"
        );
        assert_eq!(
            fs::read(&destination).unwrap(),
            b"earlier snapshot, never to be replaced",
            "an existing file must be left exactly as it was"
        );
        assert_eq!(
            read_migration_versions(&fixture),
            markers_before,
            "a failed backup must not touch the source database"
        );
        assert_eq!(
            read_setting_value(&fixture, "stats").as_deref(),
            Some(r#"{"totalChars":1234,"totalDurationSec":56.0}"#)
        );
        assert!(!usage::usage_events_exists(&fixture).unwrap());

        drop(fixture);
        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn failed_backup_removes_the_copy_it_created() {
        let dir = test_db_dir("snapshot-cleanup");
        let source = dir.join("corrupt.db");
        fs::write(&source, b"this is not a SQLite database").unwrap();
        let broken = Connection::open(&source).unwrap();

        let destination = dir.join("sayit-before-migration-20000101T000000Z-partial.sqlite3");
        let error = Storage::create_verified_snapshot(&broken, &destination).unwrap_err();

        assert!(
            error.to_string().contains("pre-migration backup"),
            "the error must say the backup failed: {error}"
        );
        assert!(
            !destination.exists(),
            "an incomplete copy must not stay behind"
        );

        // The cleanup owns the attempt's sidecars too: recreate an incomplete
        // copy with the `-wal`/`-shm` files SQLite would have attached to it.
        let destination_name = destination
            .file_name()
            .unwrap()
            .to_string_lossy()
            .into_owned();
        fs::write(&destination, b"incomplete copy").unwrap();
        fs::write(dir.join(format!("{destination_name}-wal")), b"leftover wal").unwrap();
        fs::write(dir.join(format!("{destination_name}-shm")), b"leftover shm").unwrap();
        Storage::remove_failed_snapshot(&destination);
        let remaining: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(&destination_name))
            .collect();
        assert!(
            remaining.is_empty(),
            "the failed attempt's own files must all be removed, found {remaining:?}"
        );

        drop(broken);
        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn snapshot_verification_rejects_a_file_that_is_not_an_intact_database() {
        let dir = test_db_dir("snapshot-verification");
        let garbage = dir.join("sayit-before-migration-20000101T000000Z-garbage.sqlite3");
        fs::write(&garbage, b"not a database").unwrap();

        let error = Storage::verify_snapshot(&garbage).unwrap_err();

        assert!(
            error.to_string().contains("pre-migration backup"),
            "the error must say the backup failed: {error}"
        );
        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn snapshot_normalization_refuses_a_missing_destination() {
        let dir = test_db_dir("snapshot-normalize-missing");
        let destination = dir.join("sayit-before-migration-20000101T000000Z-missing.sqlite3");

        let error = Storage::normalize_snapshot_journal_mode(&destination).unwrap_err();

        assert!(
            error.to_string().contains("pre-migration backup"),
            "the error must say the backup failed: {error}"
        );
        assert!(
            !destination.exists(),
            "a missing copy must not be recreated as an empty database"
        );

        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn verified_snapshot_survives_a_later_migration_failure() {
        let dir = test_db_dir("snapshot-migration-failure");
        let path = dir.join("sayit.db");

        // A database that records version 1 but is missing the tables
        // migration 2 alters: the snapshot succeeds, the migration then fails.
        {
            let fixture = Connection::open(&path).unwrap();
            fixture
                .execute_batch(
                    "CREATE TABLE schema_migrations (
                         version INTEGER PRIMARY KEY,
                         name TEXT NOT NULL,
                         applied_at INTEGER NOT NULL
                     );
                     INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'init-sqlite-storage', 0);",
                )
                .unwrap();
        }

        let error = match Storage::new(path.clone()) {
            Ok(_) => panic!("migration 2 must fail on a database without history_records"),
            Err(error) => error,
        };
        assert!(
            error.to_string().contains("history_records"),
            "the migration must be the step that failed: {error}"
        );

        let snapshots = snapshot_files(&dir);
        assert_eq!(
            snapshots.len(),
            1,
            "a failed migration must not remove the verified snapshot"
        );
        let copy =
            Connection::open_with_flags(&snapshots[0], rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        assert_eq!(read_migration_versions(&copy), vec![1]);
        drop(copy);

        let live = Connection::open(&path).unwrap();
        assert_eq!(
            read_migration_versions(&live),
            vec![1],
            "the failed startup must not have applied later migrations"
        );
        drop(live);

        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }

    #[test]
    fn renamed_snapshot_is_a_standalone_database_and_restores_the_old_state() {
        let dir = test_db_dir("snapshot-rename-restore");
        let path = dir.join("sayit.db");
        let fixture = legacy_database_fixture(&path);
        // One old history record, so the restored copy can prove history and
        // the usage backfill, not merely that the file opens.
        fixture
            .execute(
                "INSERT INTO history_records
                     (id, list_order, timestamp, favorite, char_count, duration_sec, is_empty, app_id, app_name, raw_json)
                 VALUES ('legacy-record-1', 0, 1737000000000, 0, 40, 1.5, 0, 'Code.exe', 'Code',
                     '{\"id\":\"legacy-record-1\",\"timestamp\":1737000000000,\"charCount\":40,\"durationSec\":1.5,\"processName\":\"Code.exe\"}')",
                [],
            )
            .unwrap();

        let storage = Storage::new(path.clone()).unwrap();
        let snapshots = snapshot_files(&dir);
        assert_eq!(snapshots.len(), 1);
        let snapshot = snapshots[0].clone();
        let snapshot_name = snapshot.file_name().unwrap().to_string_lossy().into_owned();
        drop(storage);
        drop(fixture);

        // The snapshot must be an ordinary rollback-journal database: one
        // self-contained file the user can rename or archive anywhere and open
        // with a plain read-only connection, with no sidecar files.
        let header = fs::read(&snapshot).unwrap();
        assert_eq!(
            (header[18], header[19]),
            (1, 1),
            "the copy must carry rollback-journal format versions"
        );
        let copy =
            Connection::open_with_flags(&snapshot, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let journal_mode: String = copy
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap();
        assert_eq!(journal_mode, "delete");
        let quick_check: Vec<String> = {
            let mut statement = copy.prepare("PRAGMA quick_check").unwrap();
            statement
                .query_map([], |row| row.get(0))
                .unwrap()
                .collect::<SqlResult<Vec<String>>>()
                .unwrap()
        };
        assert_eq!(quick_check, vec!["ok".to_string()]);
        assert!(
            !usage::usage_events_exists(&copy).unwrap(),
            "the snapshot must predate the usage schema"
        );
        assert_eq!(read_migration_versions(&copy), vec![1]);
        assert_eq!(
            read_setting_value(&copy, "walOnlySentinel").as_deref(),
            Some("\"committed-to-wal\"")
        );
        drop(copy);

        // Neither the startup that wrote it nor the read-only open above may
        // leave `-wal`/`-shm` files named after the snapshot.
        let companions: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with(&snapshot_name))
            .collect();
        assert_eq!(
            companions,
            vec![snapshot_name.clone()],
            "the snapshot must stand alone without sidecar files"
        );

        // The restore flow the feature promises: keep the already-migrated
        // database aside, rename the snapshot to the app's database name, and
        // let a real startup open it.
        fs::rename(&path, dir.join("sayit-migrated.db")).unwrap();
        fs::rename(&snapshot, &path).unwrap();

        let restored = Storage::new(path.clone()).unwrap();
        {
            let live = restored.db.lock().unwrap();
            assert_eq!(read_migration_versions(&live), vec![1, 2, 3, 5]);
        }
        assert_eq!(
            restored.get("walOnlySentinel", None),
            serde_json::json!("committed-to-wal"),
            "the old settings must survive the renamed snapshot"
        );
        let history = restored.history_list(None, false, None, None).unwrap();
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["id"], "legacy-record-1");
        let summary = restored.usage_summary(None).unwrap();
        assert_eq!(
            (
                summary.takes,
                summary.total_chars,
                summary.dated_takes,
                summary.dated_chars
            ),
            (7, 1234, 1, 40),
            "usage must be backfilled from the old counters and history"
        );

        let migrated = Connection::open(dir.join("sayit-migrated.db")).unwrap();
        assert_eq!(
            read_migration_versions(&migrated),
            vec![1, 2, 3, 5],
            "the set-aside database holds the newer changes the snapshot predates"
        );
        drop(migrated);

        drop(restored);
        fs::remove_dir_all(&dir).expect("test directory must be removable after all handles close");
    }
}

// ─── Backup / restore helpers (for import and export) ───
impl Storage {
    /// Exports app_settings as a { key: value } object; excluded keys are skipped.
    pub fn export_app_settings(&self, exclude: &[&str]) -> SqlResult<Value> {
        let db = self.db.lock().unwrap();
        let mut map = serde_json::Map::new();
        let mut stmt = db.prepare("SELECT key, value_json FROM app_settings")?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        for row in rows {
            let (key, value_json) = row?;
            if exclude.contains(&key.as_str()) {
                continue;
            }
            let value = serde_json::from_str(&value_json)
                .map_err(|error| json_conversion_error(format!("app setting '{key}'"), error))?;
            map.insert(key, value);
        }
        Ok(Value::Object(map))
    }

    /// Applies settings and optional collections atomically: they either all
    /// succeed or all roll back.
    fn apply_config_on(
        tx: &Connection,
        app_settings: &serde_json::Map<String, Value>,
        exclude: &[&str],
        prompt_presets: Option<&[Value]>,
        app_prompt_rules: Option<&[Value]>,
    ) -> SqlResult<()> {
        let now = chrono::Utc::now().timestamp_millis();

        for (key, value) in app_settings {
            if exclude.contains(&key.as_str()) {
                continue;
            }
            let json_str = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
            tx.execute(
                "INSERT INTO app_settings (key, value_json, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
                params![key, json_str, now],
            )?;
        }

        if let Some(items) = prompt_presets {
            Self::replace_collection_on(tx, "promptPresets", items)?;
        }
        if let Some(items) = app_prompt_rules {
            Self::replace_collection_on(tx, "appPromptRules", items)?;
        }

        Ok(())
    }

    pub fn apply_config_transaction(
        &self,
        app_settings: &serde_json::Map<String, Value>,
        exclude: &[&str],
        prompt_presets: Option<&[Value]>,
        app_prompt_rules: Option<&[Value]>,
    ) -> SqlResult<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        Self::apply_config_on(&tx, app_settings, exclude, prompt_presets, app_prompt_rules)?;
        tx.commit()
    }

    pub fn restore_full_transaction(
        &self,
        app_settings: &serde_json::Map<String, Value>,
        settings_exclude: &[&str],
        prompt_presets: Option<&[Value]>,
        app_prompt_rules: Option<&[Value]>,
        history: Option<&[Value]>,
        manual_corrections: Option<&[Value]>,
        feedback_queue: Option<&[Value]>,
        usage: Option<&UsageBackup>,
    ) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        let tx = db.unchecked_transaction()?;

        Self::apply_config_on(
            &tx,
            app_settings,
            settings_exclude,
            prompt_presets,
            app_prompt_rules,
        )?;
        if let Some(items) = history {
            Self::replace_collection_on(&tx, "history", items)?;
        }
        if let Some(items) = manual_corrections {
            Self::replace_collection_on(&tx, "manualCorrections", items)?;
        }
        if let Some(items) = feedback_queue {
            Self::replace_collection_on(&tx, "feedbackQueue", items)?;
        }
        usage::usage_restore_on(&tx, usage)?;

        tx.commit()
    }
}

#[cfg(test)]
mod history_order_tests {
    use super::*;
    use serde_json::json;

    fn memory_storage() -> Storage {
        Storage::new(PathBuf::from(":memory:")).unwrap()
    }

    fn record(id: &str) -> Value {
        json!({
            "id": id,
            "timestamp": 1_700_000_000_i64,
            "text": format!("text of {id}"),
            "charCount": 10,
            "durationSec": 1.5,
            "isEmpty": false,
            "favorite": false
        })
    }

    fn favorite_record(id: &str) -> Value {
        let mut value = record(id);
        value["favorite"] = json!(true);
        value
    }

    /// Seeds rows the way the old scheme (and `set("history", ...)`) numbers them: 0..n.
    fn seed_old_rows(storage: &Storage, ids: &[&str]) {
        let rows: Vec<Value> = ids.iter().map(|id| record(id)).collect();
        storage.set("history", &Value::Array(rows)).unwrap();
    }

    fn add_all(storage: &Storage, ids: &[&str]) {
        for id in ids {
            storage.history_add(&record(id)).unwrap();
        }
    }

    fn ids_of(rows: &[Value]) -> Vec<String> {
        rows.iter()
            .map(|row| row["id"].as_str().unwrap().to_string())
            .collect()
    }

    fn listed_ids(storage: &Storage) -> Vec<String> {
        ids_of(&storage.history_list(None, false, None, None).unwrap())
    }

    /// Reads `(id, list_order)` pairs sorted by id. The connection guard is
    /// released before returning, so callers can keep using the storage.
    fn stored_orders(storage: &Storage) -> Vec<(String, i64)> {
        let db = storage.db.lock().unwrap();
        let mut stmt = db
            .prepare("SELECT id, list_order FROM history_records ORDER BY id")
            .unwrap();
        let rows = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<SqlResult<Vec<(String, i64)>>>()
            .unwrap();
        rows
    }

    fn order_of(storage: &Storage, id: &str) -> i64 {
        stored_orders(storage)
            .into_iter()
            .find(|(row_id, _)| row_id == id)
            .unwrap_or_else(|| panic!("row {id} must exist"))
            .1
    }

    fn assert_distinct_orders(storage: &Storage) {
        let mut orders: Vec<i64> = stored_orders(storage)
            .into_iter()
            .map(|(_, order)| order)
            .collect();
        let total = orders.len();
        orders.sort_unstable();
        orders.dedup();
        assert_eq!(orders.len(), total, "list_order values must stay unique");
    }

    fn strs(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| value.to_string()).collect()
    }

    #[test]
    fn t1_added_records_are_listed_newest_first() {
        let storage = memory_storage();
        add_all(&storage, &["a", "b", "c"]);

        assert_eq!(listed_ids(&storage), strs(&["c", "b", "a"]));
        assert_distinct_orders(&storage);
    }

    #[test]
    fn t2_new_records_precede_rows_numbered_by_the_old_scheme() {
        let storage = memory_storage();
        seed_old_rows(&storage, &["old1", "old2"]);
        assert_eq!(order_of(&storage, "old1"), 0);
        assert_eq!(order_of(&storage, "old2"), 1);

        add_all(&storage, &["new1", "new2"]);

        assert_eq!(
            listed_ids(&storage),
            strs(&["new2", "new1", "old1", "old2"])
        );
        assert_eq!(order_of(&storage, "new1"), -1);
        assert_eq!(order_of(&storage, "new2"), -2);
        assert_eq!(
            order_of(&storage, "old1"),
            0,
            "old rows must not be renumbered"
        );
        assert_eq!(
            order_of(&storage, "old2"),
            1,
            "old rows must not be renumbered"
        );
    }

    #[test]
    fn t3_delete_keeps_order_across_the_positive_and_negative_ranges() {
        let storage = memory_storage();
        seed_old_rows(&storage, &["old0", "old1", "old2"]);
        add_all(&storage, &["n1", "n2", "n3"]);
        assert_eq!(
            listed_ids(&storage),
            strs(&["n3", "n2", "n1", "old0", "old1", "old2"])
        );

        storage.history_delete("old1").unwrap();
        assert_eq!(
            listed_ids(&storage),
            strs(&["n3", "n2", "n1", "old0", "old2"]),
            "deleting in the positive range"
        );
        assert_distinct_orders(&storage);

        storage.history_delete("n2").unwrap();
        assert_eq!(
            listed_ids(&storage),
            strs(&["n3", "n1", "old0", "old2"]),
            "deleting in the negative range"
        );
        assert_distinct_orders(&storage);

        storage.history_add(&record("n4")).unwrap();
        assert_eq!(
            listed_ids(&storage),
            strs(&["n4", "n3", "n1", "old0", "old2"]),
            "a record added after deletions is listed first"
        );
        assert_distinct_orders(&storage);

        storage.history_delete("n1").unwrap();
        assert_eq!(
            listed_ids(&storage),
            strs(&["n4", "n3", "old0", "old2"]),
            "deleting the last negative row next to the positive range"
        );
        assert_distinct_orders(&storage);

        storage.history_delete("n4").unwrap();
        storage.history_add(&record("n5")).unwrap();
        assert_eq!(
            listed_ids(&storage),
            strs(&["n5", "n3", "old0", "old2"]),
            "deleting the newest row and adding again"
        );
        assert_distinct_orders(&storage);
    }

    #[test]
    fn t4_adding_does_not_rewrite_existing_rows() {
        let storage = memory_storage();
        seed_old_rows(&storage, &["old1", "old2"]);
        add_all(&storage, &["x", "y"]);

        let before = stored_orders(&storage);
        assert_eq!(before.len(), 4);
        let lowest_before = before.iter().map(|(_, order)| *order).min().unwrap();

        storage.history_add(&record("z")).unwrap();

        let after = stored_orders(&storage);
        assert_eq!(after.len(), before.len() + 1);
        for (id, order) in &before {
            assert!(
                after.contains(&(id.clone(), *order)),
                "row {id} must keep list_order {order}"
            );
        }
        let new_order = order_of(&storage, "z");
        assert!(
            new_order < lowest_before,
            "the new row ({new_order}) must be strictly below every existing row ({lowest_before})"
        );
        assert_eq!(new_order, lowest_before - 1);
    }

    #[test]
    fn t5_pagination_spans_old_and_new_rows() {
        let storage = memory_storage();
        seed_old_rows(&storage, &["old0", "old1", "old2"]);
        add_all(&storage, &["n1", "n2", "n3"]);

        let page = |limit: i64, offset: i64| {
            ids_of(
                &storage
                    .history_list(None, false, Some(limit), Some(offset))
                    .unwrap(),
            )
        };

        assert_eq!(page(2, 0), strs(&["n3", "n2"]));
        assert_eq!(
            page(2, 2),
            strs(&["n1", "old0"]),
            "slice across the sign change"
        );
        assert_eq!(page(2, 4), strs(&["old1", "old2"]));
        assert_eq!(page(10, 5), strs(&["old2"]));
        assert_eq!(page(2, 6), Vec::<String>::new());
    }

    #[test]
    fn t6_duplicate_id_fails_and_leaves_the_table_unchanged() {
        let storage = memory_storage();
        seed_old_rows(&storage, &["old1"]);
        add_all(&storage, &["a", "b"]);

        let orders_before = stored_orders(&storage);
        let listed_before = listed_ids(&storage);

        let mut duplicate = record("a");
        duplicate["text"] = json!("replacement that must not be stored");
        assert!(storage.history_add(&duplicate).is_err());
        assert!(
            storage.history_add(&record("old1")).is_err(),
            "an id seeded by the old scheme is a duplicate too"
        );

        assert_eq!(stored_orders(&storage), orders_before);
        assert_eq!(listed_ids(&storage), listed_before);
        let rows = storage.history_list(None, false, None, None).unwrap();
        let original = rows.iter().find(|row| row["id"] == "a").unwrap();
        assert_eq!(original["text"], "text of a");

        storage.history_add(&record("c")).unwrap();
        assert_eq!(listed_ids(&storage), strs(&["c", "b", "a", "old1"]));
    }

    #[test]
    fn t7_favorite_filter_returns_favorites_newest_first() {
        let storage = memory_storage();
        let mut old_favorite = record("old1");
        old_favorite["favorite"] = json!(true);
        storage
            .set("history", &json!([old_favorite, record("old2")]))
            .unwrap();
        storage.history_add(&favorite_record("n1")).unwrap();
        storage.history_add(&record("n2")).unwrap();
        storage.history_add(&favorite_record("n3")).unwrap();

        let favorites = storage.history_list(None, true, None, None).unwrap();

        assert_eq!(ids_of(&favorites), strs(&["n3", "n1", "old1"]));
        assert_eq!(storage.history_count(None, true).unwrap(), 3);
        assert_eq!(
            ids_of(&storage.history_list(None, true, Some(2), Some(1)).unwrap()),
            strs(&["n1", "old1"])
        );
    }
}

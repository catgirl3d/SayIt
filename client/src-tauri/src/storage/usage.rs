//! Anonymous usage log: one row per completed dictation, recorded whether or
//! not history saving is on. A row holds only when (floored to 15 minutes),
//! how many characters, how long, the foreground process name, the processing
//! mode, and the prompt preset id — never dictated text, audio paths, window
//! titles, or user-written preset names.
//!
//! Rows with `ts = NULL` are the undated baseline carried over from the legacy
//! counters (`stats` / `userStats`) at upgrade time. They count toward all-time
//! totals and the app breakdown, never toward a period, the hour chart, the
//! daily average, or the longest take. Two kinds exist: per-app rows carrying
//! the profile residual in `legacy_profile_chars` (`char_count` stays 0, so the
//! overall total is not inflated by profile characters), and one unattributed
//! row carrying the overall `totalChars` / duration residual in plain columns.

use super::Storage;
use chrono::{Local, TimeZone, Timelike};
use rusqlite::{Connection, OptionalExtension, Result as SqlResult, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet};

pub(crate) const MIGRATION_005_SQL: &str = include_str!("migration_005_usage_events.sql");

/// Adds `legacy_profile_chars` to a `usage_events` table created by the
/// previous add-usage-events implementation. Keep the CHECK predicate
/// identical to the one in migration_005_usage_events.sql.
pub(crate) const MIGRATION_005_ADD_LEGACY_PROFILE_CHARS_SQL: &str =
    "ALTER TABLE usage_events ADD COLUMN legacy_profile_chars INTEGER CHECK (
         legacy_profile_chars IS NULL OR (
             ts IS NULL AND app_id IS NOT NULL AND char_count = 0 AND legacy_profile_chars >= 0
         )
     );";

/// Whether the usage table already exists, so the usage migration can tell an
/// upgrade (add the new column, never re-backfill) from a first install.
pub(crate) fn usage_events_exists(db: &Connection) -> SqlResult<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_events')",
        [],
        |row| row.get(0),
    )
}

/// Every UTC offset in use is a multiple of 15 minutes, so flooring to this
/// step keeps each event's local day and hour intact while dropping the exact
/// minute of the dictation.
const TS_GRANULARITY_MS: i64 = 15 * 60 * 1000;

const FIRST_USED_AT_META_KEY: &str = "usage_first_used_at";
const LEGACY_STATS_KEY: &str = "stats";
const LEGACY_USER_STATS_KEY: &str = "userStats";

pub(crate) fn floor_usage_ts(ts_ms: i64) -> i64 {
    ts_ms - ts_ms.rem_euclid(TS_GRANULARITY_MS)
}

/// One completed dictation as reported by the recorder.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEventInput {
    pub char_count: i64,
    pub duration_sec: f64,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub work_mode: Option<String>,
    #[serde(default)]
    pub prompt_preset_id: Option<String>,
}

impl UsageEventInput {
    pub fn validate(&self) -> Result<(), String> {
        if self.char_count < 0 {
            return Err(format!(
                "charCount must be non-negative, got {}",
                self.char_count
            ));
        }
        if !self.duration_sec.is_finite() || self.duration_sec < 0.0 {
            return Err(format!(
                "durationSec must be finite and non-negative, got {}",
                self.duration_sec
            ));
        }
        Ok(())
    }
}

/// A stored row, in the shape carried by full backups.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEventRow {
    pub ts: Option<i64>,
    pub takes: i64,
    pub char_count: i64,
    pub duration_sec: f64,
    #[serde(default)]
    pub app_id: Option<String>,
    #[serde(default)]
    pub work_mode: Option<String>,
    #[serde(default)]
    pub prompt_preset_id: Option<String>,
    /// Historical per-app characters from the legacy `domainWords` counter.
    /// Only undated, app-attributed baseline rows from the migration carry it,
    /// and live or dated rows never do. `None` means "use char_count", which
    /// keeps format-1 archives on their original behavior.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub legacy_profile_chars: Option<i64>,
}

/// The `usage` section of a full backup.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBackup {
    pub first_used_at: Option<i64>,
    pub events: Vec<UsageEventRow>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageBreakdown {
    pub key: String,
    pub takes: i64,
    pub chars: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSummary {
    pub takes: i64,
    pub total_chars: i64,
    pub total_duration_sec: f64,
    /// Dated rows only; the daily average must not spread the undated baseline.
    pub dated_takes: i64,
    pub dated_chars: i64,
    pub max_duration_sec: f64,
    /// Distinct local calendar days with at least one dated event.
    pub active_days: i64,
    /// Dated takes per local hour of day, 24 entries.
    pub hour_buckets: Vec<i64>,
    pub apps: Vec<UsageBreakdown>,
    pub work_modes: Vec<UsageBreakdown>,
    pub prompt_presets: Vec<UsageBreakdown>,
    /// Describes the installation, not the range: survives "Clear statistics".
    pub first_used_at: Option<i64>,
    pub last_used_at: Option<i64>,
}

/// Parses and validates the `usage` section of a full backup before anything
/// is written, so a malformed section aborts the restore instead of leaving it
/// half applied.
pub fn parse_usage_backup(value: &Value) -> Result<UsageBackup, String> {
    let backup: UsageBackup = serde_json::from_value(value.clone())
        .map_err(|e| format!("usage has an invalid format: {}", e))?;
    for (index, row) in backup.events.iter().enumerate() {
        if row.takes < 0
            || row.char_count < 0
            || !row.duration_sec.is_finite()
            || row.duration_sec < 0.0
        {
            return Err(format!(
                "usage event {} has negative or non-finite values",
                index
            ));
        }
        if let Some(legacy_chars) = row.legacy_profile_chars {
            if legacy_chars < 0 || row.ts.is_some() || row.app_id.is_none() || row.char_count != 0 {
                return Err(format!(
                    "usage event {} carries legacyProfileChars outside an undated app profile row",
                    index
                ));
            }
        }
    }
    Ok(backup)
}

impl Storage {
    /// Appends one completed dictation; `at_ms` is UTC milliseconds and is
    /// floored before it is stored.
    pub fn usage_record(&self, at_ms: i64, event: &UsageEventInput) -> SqlResult<()> {
        event.validate().map_err(|error| {
            rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                error,
            )))
        })?;
        let db = self.db.lock().unwrap();
        let tx = db.unchecked_transaction()?;
        let ts = floor_usage_ts(at_ms);
        insert_row(
            &tx,
            &UsageEventRow {
                ts: Some(ts),
                takes: 1,
                char_count: event.char_count,
                duration_sec: event.duration_sec,
                app_id: non_empty(event.app_id.as_deref()),
                work_mode: non_empty(event.work_mode.as_deref()),
                prompt_preset_id: non_empty(event.prompt_preset_id.as_deref()),
                legacy_profile_chars: None,
            },
        )?;
        lower_first_used_at(&tx, ts)?;
        tx.commit()
    }

    /// Aggregates rows with `ts >= since_ms`, or every row (the undated
    /// baseline included) when `since_ms` is `None`.
    pub fn usage_summary(&self, since_ms: Option<i64>) -> SqlResult<UsageSummary> {
        let db = self.db.lock().unwrap();
        summarize(&db, since_ms)
    }

    /// Deletes every usage row. The first-use date is kept: it describes the
    /// installation, and clearing statistics never reset it before either.
    pub fn usage_clear(&self) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        db.execute("DELETE FROM usage_events", [])?;
        Ok(())
    }

    pub fn usage_backup(&self) -> SqlResult<UsageBackup> {
        let db = self.db.lock().unwrap();
        Ok(UsageBackup {
            first_used_at: read_first_used_at(&db)?,
            events: read_rows(&db, None)?,
        })
    }

    /// Applies a full backup's usage section. A present section replaces local
    /// usage wholesale, an empty one included. An absent section — a backup
    /// made before usage events existed — keeps local usage, or rebuilds it
    /// from the restored history and legacy counters when there is none.
    pub fn usage_restore(&self, backup: Option<&UsageBackup>) -> SqlResult<()> {
        let db = self.db.lock().unwrap();
        let tx = db.unchecked_transaction()?;
        match backup {
            Some(backup) => {
                tx.execute("DELETE FROM usage_events", [])?;
                for row in &backup.events {
                    insert_row(&tx, row)?;
                }
                match backup.first_used_at {
                    Some(ts) => write_first_used_at(&tx, ts)?,
                    None => {
                        tx.execute(
                            "DELETE FROM db_meta WHERE key = ?1",
                            params![FIRST_USED_AT_META_KEY],
                        )?;
                    }
                }
                // The section supersedes any legacy counters inside the
                // restored appSettings; keeping them would let a later rebuild
                // resurrect numbers the user already cleared.
                delete_legacy_counters(&tx)?;
            }
            None => rebuild_usage_from_legacy(&tx)?,
        }
        tx.commit()
    }
}

/// Seeds usage rows from history and the legacy counters when the table is
/// empty, then drops the legacy counters so the two can never diverge again.
/// Runs inside the caller's transaction: migration 5, the Electron import, and
/// restoring a backup that predates usage events.
pub(crate) fn rebuild_usage_from_legacy(db: &Connection) -> SqlResult<()> {
    let has_rows: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM usage_events)", [], |row| {
        row.get(0)
    })?;
    if !has_rows {
        backfill_from_legacy(db)?;
    }
    delete_legacy_counters(db)
}

fn backfill_from_legacy(db: &Connection) -> SqlResult<()> {
    let stats = read_legacy_json(db, LEGACY_STATS_KEY)?;
    let user_stats = read_legacy_json(db, LEGACY_USER_STATS_KEY)?;
    let legacy_chars = legacy_count(stats.get("totalChars"));
    let legacy_duration = legacy_seconds(stats.get("totalDurationSec"));
    let legacy_takes = legacy_count(user_stats.get("totalSessions"));
    let app_takes = legacy_count_map(user_stats.get("appUsageCount"));
    let app_chars = legacy_count_map(user_stats.get("domainWords"));
    // The old counters bucketed dictations with no process name and no matched
    // prompt under "unknown" (buildStatsAppId), while history records no exe
    // path. An app-less record joins that same bucket — in its own row and in
    // the per-app remainder — to stay counted exactly once, but only when the
    // legacy counters actually have the key; otherwise it stays unattributed.
    let legacy_unknown = app_takes.contains_key("unknown") || app_chars.contains_key("unknown");

    let records: Vec<(i64, i64, f64, String)> = {
        let mut stmt = db.prepare(
            "SELECT timestamp, char_count, duration_sec, raw_json FROM history_records
             WHERE is_empty = 0 ORDER BY list_order DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?;
        rows.collect::<SqlResult<Vec<_>>>()?
    };

    // 1. One dated row per non-empty history record.
    let mut history_takes = 0i64;
    let mut history_chars = 0i64;
    let mut history_duration = 0.0f64;
    let mut history_by_app: HashMap<String, (i64, i64)> = HashMap::new();
    let mut earliest: Option<i64> = None;
    for (timestamp, char_count, duration_sec, raw_json) in &records {
        let raw: Value = match serde_json::from_str(raw_json) {
            Ok(value) => value,
            Err(error) => {
                log::warn!(
                    "Ignoring malformed history JSON while rebuilding usage for timestamp {}: {}",
                    timestamp,
                    error
                );
                Value::Null
            }
        };
        let text = |key: &str| non_empty(raw.get(key).and_then(Value::as_str));
        // Same precedence as buildStatsAppId: the process name first, then the
        // matched prompt rule's app id, then the legacy unknown bucket.
        let app_id = text("processName")
            .or_else(|| text("appId"))
            .or_else(|| legacy_unknown.then(|| "unknown".to_string()));
        let duration = pick_voice_duration_sec(
            *duration_sec,
            raw.get("audioDurationSec").and_then(Value::as_f64),
            raw.get("asrDurationSec").and_then(Value::as_f64),
        );
        let char_count = (*char_count).max(0);
        let ts = (*timestamp > 0).then(|| floor_usage_ts(*timestamp));
        insert_row(
            db,
            &UsageEventRow {
                ts,
                takes: 1,
                char_count,
                duration_sec: duration,
                app_id: app_id.clone(),
                work_mode: text("workMode"),
                prompt_preset_id: text("promptPresetId"),
                legacy_profile_chars: None,
            },
        )?;
        history_takes += 1;
        history_chars += char_count;
        history_duration += duration;
        if let Some(app) = app_id {
            let entry = history_by_app.entry(app).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += char_count;
        }
        if let Some(ts) = ts {
            earliest = Some(earliest.map_or(ts, |current| current.min(ts)));
        }
    }

    // 2. Per-app remainder: keeps the app breakdown and the personalization
    //    profile (dominant scene, derived from per-app characters) unchanged.
    //    The legacy per-app characters accumulated independently of the
    //    overall total (history mutations reduced one and not always the
    //    other), so they go into legacy_profile_chars while char_count stays
    //    0: the overall total must not inherit them.
    let mut baseline_app_takes = 0i64;
    let apps: BTreeSet<&String> = app_takes.keys().chain(app_chars.keys()).collect();
    for app in apps {
        let (seen_takes, seen_chars) = history_by_app.get(app.as_str()).copied().unwrap_or((0, 0));
        let takes = (app_takes.get(app.as_str()).copied().unwrap_or(0) - seen_takes).max(0);
        let chars = (app_chars.get(app.as_str()).copied().unwrap_or(0) - seen_chars).max(0);
        if takes == 0 && chars == 0 {
            continue;
        }
        insert_row(
            db,
            &UsageEventRow {
                ts: None,
                takes,
                char_count: 0,
                duration_sec: 0.0,
                app_id: Some(app.clone()),
                work_mode: None,
                prompt_preset_id: None,
                legacy_profile_chars: Some(chars),
            },
        )?;
        baseline_app_takes += takes;
    }

    // 3. Whatever the legacy overall total holds beyond the dated rows:
    //    dictations made while history was off, or whose records were deleted.
    //    It is a separate historic aggregate from the per-app profile rows and
    //    does not subtract their characters.
    let rest_takes = (legacy_takes - history_takes - baseline_app_takes).max(0);
    let rest_chars = (legacy_chars - history_chars).max(0);
    let rest_duration = (legacy_duration - history_duration).max(0.0);
    if rest_takes > 0 || rest_chars > 0 || rest_duration > 0.0 {
        insert_row(
            db,
            &UsageEventRow {
                ts: None,
                takes: rest_takes,
                char_count: rest_chars,
                duration_sec: rest_duration,
                app_id: None,
                work_mode: None,
                prompt_preset_id: None,
                legacy_profile_chars: None,
            },
        )?;
    }

    let legacy_first_used = user_stats
        .get("firstUsedAt")
        .and_then(Value::as_i64)
        .filter(|ts| *ts > 0);
    if let Some(first) = [legacy_first_used, earliest].into_iter().flatten().min() {
        lower_first_used_at(db, first)?;
    }
    Ok(())
}

fn summarize(db: &Connection, since_ms: Option<i64>) -> SqlResult<UsageSummary> {
    let rows = read_rows(db, since_ms)?;
    let mut summary = UsageSummary {
        takes: 0,
        total_chars: 0,
        total_duration_sec: 0.0,
        dated_takes: 0,
        dated_chars: 0,
        max_duration_sec: 0.0,
        active_days: 0,
        hour_buckets: vec![0; 24],
        apps: Vec::new(),
        work_modes: Vec::new(),
        prompt_presets: Vec::new(),
        first_used_at: read_first_used_at(db)?,
        last_used_at: None,
    };
    let mut apps: HashMap<String, (i64, i64)> = HashMap::new();
    let mut work_modes: HashMap<String, (i64, i64)> = HashMap::new();
    let mut prompt_presets: HashMap<String, (i64, i64)> = HashMap::new();
    let mut days = HashSet::new();

    for row in &rows {
        summary.takes += row.takes;
        summary.total_chars += row.char_count;
        summary.total_duration_sec += row.duration_sec;
        add_to_breakdown(&mut apps, row.app_id.as_deref(), row);
        add_to_breakdown(&mut work_modes, row.work_mode.as_deref(), row);
        add_to_breakdown(&mut prompt_presets, row.prompt_preset_id.as_deref(), row);

        let Some(ts) = row.ts else { continue };
        summary.dated_takes += row.takes;
        summary.dated_chars += row.char_count;
        summary.max_duration_sec = summary.max_duration_sec.max(row.duration_sec);
        summary.last_used_at = Some(summary.last_used_at.map_or(ts, |last| last.max(ts)));
        // Only out-of-range timestamps fail to convert; they still count
        // toward the totals above.
        if let Some(local) = Local.timestamp_millis_opt(ts).single() {
            summary.hour_buckets[local.hour() as usize] += row.takes;
            days.insert(local.date_naive());
        }
    }

    summary.active_days = days.len() as i64;
    summary.apps = sorted_breakdown(apps);
    summary.work_modes = sorted_breakdown(work_modes);
    summary.prompt_presets = sorted_breakdown(prompt_presets);
    Ok(summary)
}

fn add_to_breakdown(map: &mut HashMap<String, (i64, i64)>, key: Option<&str>, row: &UsageEventRow) {
    let Some(key) = key else { return };
    // Overall totals always sum char_count; a row carrying the historical
    // profile residual replaces it only in the per-app breakdown, which is
    // what the personalization profile is derived from.
    let chars = row.legacy_profile_chars.unwrap_or(row.char_count);
    let entry = map.entry(key.to_owned()).or_insert((0, 0));
    entry.0 += row.takes;
    entry.1 += chars;
}

fn sorted_breakdown(map: HashMap<String, (i64, i64)>) -> Vec<UsageBreakdown> {
    let mut items: Vec<UsageBreakdown> = map
        .into_iter()
        .map(|(key, (takes, chars))| UsageBreakdown { key, takes, chars })
        .collect();
    items.sort_by(|a, b| b.takes.cmp(&a.takes).then_with(|| a.key.cmp(&b.key)));
    items
}

fn read_rows(db: &Connection, since_ms: Option<i64>) -> SqlResult<Vec<UsageEventRow>> {
    // Two statements instead of `?1 IS NULL OR ts >= ?1`: with that predicate
    // SQLite scanned the whole table, so range queries could not use
    // `idx_usage_events_ts`, and `ORDER BY id` only forced a rowid-order scan.
    // `ts >= ?1` also excludes the undated (NULL) baseline rows from ranges,
    // which is exactly what a range means here; all-time reads skip the filter.
    const COLUMNS: &str = "ts, takes, char_count, duration_sec, app_id, work_mode, prompt_preset_id, legacy_profile_chars";

    fn map_row(row: &rusqlite::Row<'_>) -> SqlResult<UsageEventRow> {
        Ok(UsageEventRow {
            ts: row.get(0)?,
            takes: row.get(1)?,
            char_count: row.get(2)?,
            duration_sec: row.get(3)?,
            app_id: row.get(4)?,
            work_mode: row.get(5)?,
            prompt_preset_id: row.get(6)?,
            legacy_profile_chars: row.get(7)?,
        })
    }

    match since_ms {
        Some(since) => {
            let mut stmt = db.prepare(&format!(
                "SELECT {COLUMNS} FROM usage_events WHERE ts >= ?1"
            ))?;
            let rows = stmt.query_map(params![since], map_row)?;
            rows.collect()
        }
        None => {
            let mut stmt = db.prepare(&format!("SELECT {COLUMNS} FROM usage_events"))?;
            let rows = stmt.query_map([], map_row)?;
            rows.collect()
        }
    }
}

fn insert_row(db: &Connection, row: &UsageEventRow) -> SqlResult<()> {
    db.execute(
        "INSERT INTO usage_events (ts, takes, char_count, duration_sec, app_id, work_mode, prompt_preset_id, legacy_profile_chars)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            row.ts,
            row.takes,
            row.char_count,
            row.duration_sec,
            row.app_id,
            row.work_mode,
            row.prompt_preset_id,
            row.legacy_profile_chars
        ],
    )?;
    Ok(())
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

/// Mirrors `pickVoiceDurationSec` in `src/services/timeModel.ts`: wall-clock
/// hold time first, then the ASR-reported length, then the audio length.
fn pick_voice_duration_sec(hold: f64, audio: Option<f64>, asr: Option<f64>) -> f64 {
    let positive = |value: Option<f64>| value.filter(|v| v.is_finite() && *v > 0.0);
    positive(Some(hold))
        .or(positive(asr))
        .or(positive(audio))
        .unwrap_or(0.0)
}

fn invalid_first_used_at_error(raw: &str, error: impl std::fmt::Display) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        0,
        rusqlite::types::Type::Text,
        Box::new(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            format!(
                "{} contains invalid timestamp {:?}: {}",
                FIRST_USED_AT_META_KEY, raw, error
            ),
        )),
    )
}

fn read_first_used_at(db: &Connection) -> SqlResult<Option<i64>> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value_json FROM db_meta WHERE key = ?1",
            params![FIRST_USED_AT_META_KEY],
            |row| row.get(0),
        )
        .optional()?;
    match raw {
        None => Ok(None),
        Some(raw) => raw
            .trim()
            .parse::<i64>()
            .map(Some)
            .map_err(|error| invalid_first_used_at_error(&raw, error)),
    }
}

fn write_first_used_at(db: &Connection, ts: i64) -> SqlResult<()> {
    db.execute(
        "INSERT INTO db_meta (key, value_json, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
        params![
            FIRST_USED_AT_META_KEY,
            ts.to_string(),
            chrono::Utc::now().timestamp_millis()
        ],
    )?;
    Ok(())
}

/// Moves the first-use date earlier when `ts` predates it; never later.
fn lower_first_used_at(db: &Connection, ts: i64) -> SqlResult<()> {
    match read_first_used_at(db)? {
        Some(existing) if existing <= ts => Ok(()),
        _ => write_first_used_at(db, ts),
    }
}

fn delete_legacy_counters(db: &Connection) -> SqlResult<()> {
    db.execute(
        "DELETE FROM app_settings WHERE key IN (?1, ?2)",
        params![LEGACY_STATS_KEY, LEGACY_USER_STATS_KEY],
    )?;
    Ok(())
}

/// A missing or malformed legacy value reads as empty, as the old
/// `parse_stats` treated it. Malformed JSON is logged with the counter key so
/// recovery remains observable without blocking the migration.
fn read_legacy_json(db: &Connection, key: &str) -> SqlResult<Value> {
    let raw: Option<String> = db
        .query_row(
            "SELECT value_json FROM app_settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()?;
    match raw {
        None => Ok(Value::Null),
        Some(json) => match serde_json::from_str(&json) {
            Ok(value) => Ok(value),
            Err(error) => {
                log::warn!("Ignoring malformed legacy counter {}: {}", key, error);
                Ok(Value::Null)
            }
        },
    }
}

/// Legacy counters were written from JavaScript numbers: accept integral
/// floats and read negative or non-finite values as zero.
fn legacy_count(value: Option<&Value>) -> i64 {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .map(|v| v.round() as i64)
        .unwrap_or(0)
}

fn legacy_seconds(value: Option<&Value>) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(0.0)
}

fn legacy_count_map(value: Option<&Value>) -> HashMap<String, i64> {
    value
        .and_then(Value::as_object)
        .map(|object| {
            object
                .iter()
                .map(|(key, count)| (key.clone(), legacy_count(Some(count))))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Local, TimeZone};
    use serde_json::json;
    use std::collections::BTreeMap;
    use std::fs;
    use std::path::PathBuf;

    fn test_db_path(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("sayit-{name}-{}.db", uuid::Uuid::new_v4()))
    }

    /// Local wall-clock time as UTC milliseconds. The hour chart and day counts
    /// are local, so fixtures are built in local time too.
    fn local_ms(year: i32, month: u32, day: u32, hour: u32, minute: u32) -> i64 {
        Local
            .with_ymd_and_hms(year, month, day, hour, minute, 0)
            .single()
            .expect("fixture time must be unambiguous")
            .timestamp_millis()
    }

    fn event(char_count: i64, duration_sec: f64, app_id: &str) -> UsageEventInput {
        UsageEventInput {
            char_count,
            duration_sec,
            app_id: Some(app_id.to_string()),
            work_mode: Some("cloud_api".to_string()),
            prompt_preset_id: Some("intent".to_string()),
        }
    }

    /// Turns a database back into the pre-usage schema so the next
    /// `Storage::new` runs migration 5 against the legacy data.
    fn rewind_to_pre_usage_schema(storage: &Storage) {
        let db = storage.db.lock().unwrap();
        db.execute_batch(
            "DROP TABLE usage_events;
             DELETE FROM schema_migrations WHERE version IN (4, 5);
             DELETE FROM db_meta WHERE key = 'usage_first_used_at';",
        )
        .unwrap();
    }

    fn app(summary: &UsageSummary, key: &str) -> (i64, i64) {
        summary
            .apps
            .iter()
            .find(|item| item.key == key)
            .map(|item| (item.takes, item.chars))
            .unwrap_or((0, 0))
    }

    /// Rewinds `storage` to the incident state verified on the user database:
    /// `usage_events` does not exist, and version 4 is already occupied by the
    /// unrelated `seed-stats-total-sessions` marker, which the old version-4
    /// guard mistook for a completed usage migration.
    fn rewind_usage_to_foreign_version_four(storage: &Storage) {
        let db = storage.db.lock().unwrap();
        db.execute_batch(
             "DROP TABLE usage_events;
              DELETE FROM schema_migrations WHERE version IN (4, 5);
              DELETE FROM db_meta WHERE key = 'usage_first_used_at';
              INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, 'seed-stats-total-sessions', 0);",
        )
        .unwrap();
    }

    /// Rebuilds `usage_events` in the exact shape the previous add-usage-events
    /// version 4 created (no legacy_profile_chars column), keeps its rows, and
    /// rewinds the usage markers - including adding the version-4 marker back -
    /// so the next `Storage::new` runs migration 5 as an upgrade.
    fn rewind_usage_to_previous_version_four_table(storage: &Storage) {
        let db = storage.db.lock().unwrap();
        db.execute_batch(
            "CREATE TABLE usage_events_v4 (
                 id INTEGER PRIMARY KEY,
                 ts INTEGER,
                 takes INTEGER NOT NULL DEFAULT 1 CHECK (takes >= 0),
                 char_count INTEGER NOT NULL DEFAULT 0 CHECK (char_count >= 0),
                 duration_sec REAL NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
                 app_id TEXT,
                 work_mode TEXT,
                 prompt_preset_id TEXT
             );
             INSERT INTO usage_events_v4 (id, ts, takes, char_count, duration_sec, app_id, work_mode, prompt_preset_id)
                 SELECT id, ts, takes, char_count, duration_sec, app_id, work_mode, prompt_preset_id FROM usage_events;
             DROP TABLE usage_events;
             ALTER TABLE usage_events_v4 RENAME TO usage_events;
             CREATE INDEX idx_usage_events_ts ON usage_events(ts);
             DELETE FROM schema_migrations WHERE version IN (4, 5);
             INSERT INTO schema_migrations (version, name, applied_at) VALUES (4, 'add-usage-events', 0);",
        )
        .unwrap();
    }

    #[test]
    fn migration_preserves_legacy_totals_and_dates_history_records() {
        let path = test_db_path("usage-migration");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .history_add(&json!({
                "id": "h1", "timestamp": local_ms(2026, 3, 10, 9, 7),
                "charCount": 40, "durationSec": 1.5, "processName": "Code.exe",
                "workMode": "cloud_api", "promptPresetId": "intent",
            }))
            .unwrap();
        storage
            .history_add(&json!({
                "id": "h2", "timestamp": local_ms(2026, 3, 10, 10, 7),
                "charCount": 60, "durationSec": 3.0, "processName": "Telegram.exe",
                "workMode": "local",
            }))
            .unwrap();
        storage
            .history_add(&json!({
                "id": "e1", "timestamp": local_ms(2026, 3, 10, 9, 30),
                "charCount": 0, "durationSec": 2.0, "isEmpty": true, "processName": "Code.exe",
            }))
            .unwrap();
        let first_used = local_ms(2026, 3, 9, 8, 0);
        // Written after the history rows so the legacy counters hold exactly these values.
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 100.0, "totalChars": 1000 }),
            )
            .unwrap();
        storage
            .set(
                "userStats",
                &json!({
                    "totalWords": 900, "totalSessions": 50,
                    "domainWords": { "Code.exe": 500, "Telegram.exe": 100 },
                    "appUsageCount": { "Code.exe": 30, "Telegram.exe": 5 },
                    "firstUsedAt": first_used,
                }),
            )
            .unwrap();
        rewind_to_pre_usage_schema(&storage);
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let all = storage.usage_summary(None).unwrap();
        assert_eq!(all.total_chars, 1000);
        assert_eq!(all.total_duration_sec, 100.0);
        assert_eq!(all.takes, 50);
        assert_eq!((all.dated_takes, all.dated_chars), (2, 100));
        assert_eq!(all.max_duration_sec, 3.0);
        assert_eq!(app(&all, "Code.exe"), (30, 500));
        assert_eq!(app(&all, "Telegram.exe"), (5, 100));
        assert_eq!(all.hour_buckets[9], 1);
        assert_eq!(all.hour_buckets[10], 1);
        assert_eq!(
            all.work_modes,
            vec![
                UsageBreakdown {
                    key: "cloud_api".into(),
                    takes: 1,
                    chars: 40
                },
                UsageBreakdown {
                    key: "local".into(),
                    takes: 1,
                    chars: 60
                },
            ]
        );
        assert_eq!(
            all.prompt_presets,
            vec![UsageBreakdown {
                key: "intent".into(),
                takes: 1,
                chars: 40
            }]
        );
        assert_eq!(all.first_used_at, Some(first_used));
        assert_eq!(storage.get("stats", None), Value::Null);
        assert_eq!(storage.get("userStats", None), Value::Null);

        drop(storage);
        let storage = Storage::new(path.clone()).unwrap();
        assert_eq!(
            storage.usage_summary(None).unwrap(),
            all,
            "reopening must not re-run the backfill"
        );
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn migration_clamps_when_history_exceeds_legacy_counters() {
        // The user cleared statistics but kept history: the counters are below
        // the history sums. History still counts and no negative baseline appears.
        let path = test_db_path("usage-migration-clamp");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .history_add(&json!({
                "id": "h1", "timestamp": local_ms(2026, 3, 10, 9, 0),
                "charCount": 40, "durationSec": 5.0, "processName": "Code.exe",
            }))
            .unwrap();
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 0.0, "totalChars": 0 }),
            )
            .unwrap();
        storage
            .set(
                "userStats",
                &json!({ "totalSessions": 0, "domainWords": {}, "appUsageCount": {} }),
            )
            .unwrap();
        rewind_to_pre_usage_schema(&storage);
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let all = storage.usage_summary(None).unwrap();
        assert_eq!(
            (all.takes, all.total_chars, all.total_duration_sec),
            (1, 40, 5.0)
        );
        let backup = storage.usage_backup().unwrap();
        assert_eq!(
            backup.events.len(),
            1,
            "no baseline rows expected: {:?}",
            backup.events
        );
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn migration_attributes_app_less_history_to_legacy_unknown_bucket() {
        // A dictation with no foreground process name was counted under the
        // legacy counters' "unknown" fallback, while its history record carries
        // no exe path. The dated row must join that same bucket or the counters
        // count the dictation twice.
        let path = test_db_path("usage-migration-unknown");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .history_add(&json!({
                "id": "h1", "timestamp": local_ms(2026, 3, 10, 9, 7),
                "charCount": 100, "durationSec": 5.0,
            }))
            .unwrap();
        // Written after the history row so the legacy counters hold exactly these values.
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 5.0, "totalChars": 100 }),
            )
            .unwrap();
        storage
            .set(
                "userStats",
                &json!({
                    "totalSessions": 1,
                    "domainWords": { "unknown": 100 },
                    "appUsageCount": { "unknown": 1 },
                }),
            )
            .unwrap();
        rewind_to_pre_usage_schema(&storage);
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let all = storage.usage_summary(None).unwrap();
        assert_eq!(
            (all.takes, all.total_chars, all.total_duration_sec),
            (1, 100, 5.0)
        );
        assert_eq!((all.dated_takes, all.dated_chars), (1, 100));
        assert_eq!(app(&all, "unknown"), (1, 100));
        let backup = storage.usage_backup().unwrap();
        assert_eq!(
            backup.events.len(),
            1,
            "the dated row replaces the unknown baseline instead of duplicating it: {:?}",
            backup.events
        );
        assert_eq!(backup.events[0].app_id.as_deref(), Some("unknown"));
        assert_eq!(storage.get("stats", None), Value::Null);
        assert_eq!(storage.get("userStats", None), Value::Null);
        drop(storage);
        let storage = Storage::new(path.clone()).unwrap();
        assert_eq!(
            storage.usage_summary(None).unwrap(),
            all,
            "reopening must not re-run the backfill"
        );
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn migration_keeps_untagged_history_out_of_unknown_without_legacy_bucket() {
        // The fallback is conditional: without an "unknown" key in the legacy
        // counters an app-less record stays unattributed, and an explicit app
        // keeps its name.
        let path = test_db_path("usage-migration-no-unknown");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .history_add(&json!({
                "id": "h1", "timestamp": local_ms(2026, 3, 10, 9, 7),
                "charCount": 100, "durationSec": 5.0,
            }))
            .unwrap();
        storage
            .history_add(&json!({
                "id": "h2", "timestamp": local_ms(2026, 3, 10, 10, 7),
                "charCount": 50, "durationSec": 2.0, "processName": "Code.exe",
            }))
            .unwrap();
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 7.0, "totalChars": 150 }),
            )
            .unwrap();
        storage
            .set(
                "userStats",
                &json!({
                    "totalSessions": 2,
                    "domainWords": { "Code.exe": 50 },
                    "appUsageCount": { "Code.exe": 1 },
                }),
            )
            .unwrap();
        rewind_to_pre_usage_schema(&storage);
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let all = storage.usage_summary(None).unwrap();
        assert_eq!(
            (all.takes, all.total_chars, all.total_duration_sec),
            (2, 150, 7.0)
        );
        assert_eq!((all.dated_takes, all.dated_chars), (2, 150));
        assert_eq!(app(&all, "Code.exe"), (1, 50));
        assert_eq!(app(&all, "unknown"), (0, 0));
        let backup = storage.usage_backup().unwrap();
        assert_eq!(backup.events.len(), 2);
        assert_eq!(backup.events[0].app_id, None);
        assert_eq!(backup.events[1].app_id.as_deref(), Some("Code.exe"));
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn migration_five_recovers_when_version_four_marker_is_foreign() {
        // Verified user shape: history saving was off, version 4 is a foreign
        // marker, overall stats and the per-app profile are independent
        // aggregates. The overall total (29274) must not be inflated to the
        // profile sum (71355), and both must survive separately.
        let path = test_db_path("usage-migration-foreign-v4");
        let storage = Storage::new(path.clone()).unwrap();
        rewind_usage_to_foreign_version_four(&storage);
        storage
            .set(
                "stats",
                &json!({ "totalChars": 29274, "totalDurationSec": 2384.0908999991243 }),
            )
            .unwrap();
        storage
            .set(
                "userStats",
                &json!({
                    "totalSessions": 956,
                    "domainWords": { "Code.exe": 50000, "Telegram.exe": 21355 },
                    "appUsageCount": { "Code.exe": 600, "Telegram.exe": 356 },
                    "firstUsedAt": 1787361640689i64,
                }),
            )
            .unwrap();
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let all = storage.usage_summary(None).unwrap();
        assert_eq!(all.total_chars, 29274);
        assert_eq!(all.total_duration_sec, 2384.0908999991243);
        assert_eq!(all.takes, 956);
        assert_eq!(app(&all, "Code.exe"), (600, 50000));
        assert_eq!(app(&all, "Telegram.exe"), (356, 21355));
        assert_eq!(all.apps.iter().map(|item| item.chars).sum::<i64>(), 71355);
        assert_eq!(all.apps.iter().map(|item| item.takes).sum::<i64>(), 956);
        assert_eq!((all.dated_takes, all.dated_chars), (0, 0));
        assert_eq!(all.first_used_at, Some(1787361640689));

        let db = storage.db.lock().unwrap();
        let foreign_name: String = db
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = 4",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(foreign_name, "seed-stats-total-sessions");
        let five_count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 5",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(five_count, 1);
        drop(db);

        assert_eq!(storage.get("stats", None), Value::Null);
        assert_eq!(storage.get("userStats", None), Value::Null);
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        assert_eq!(
            storage.usage_summary(None).unwrap(),
            all,
            "reopening must not re-run the backfill"
        );
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn migration_five_adds_profile_column_to_existing_usage_without_changing_rows() {
        let path = test_db_path("usage-migration-v4-rows");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(11, 2.0, "Code.exe"))
            .unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 10, 0), &event(7, 1.0, "Telegram.exe"))
            .unwrap();
        let before = storage.usage_summary(None).unwrap();
        rewind_usage_to_previous_version_four_table(&storage);
        // The legacy counters can re-appear in app_settings (a settings restore
        // does that); upgrading an existing table must still not re-backfill.
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 50.0, "totalChars": 9999 }),
            )
            .unwrap();
        storage
            .set("userStats", &json!({ "totalSessions": 40 }))
            .unwrap();
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        assert_eq!(
            storage.usage_summary(None).unwrap(),
            before,
            "upgrading the schema must keep every existing usage row"
        );
        let has_column: i64 = storage
            .db
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('usage_events') WHERE name = 'legacy_profile_chars'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(has_column, 1);
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn migration_five_keeps_cleared_usage_empty_and_preserves_first_use() {
        let path = test_db_path("usage-migration-v4-cleared");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .history_add(&json!({
                "id": "kept-1", "timestamp": local_ms(2026, 3, 10, 9, 0),
                "charCount": 40, "durationSec": 2.0, "processName": "Code.exe",
            }))
            .unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        let first_used = storage.usage_summary(None).unwrap().first_used_at.unwrap();
        storage.usage_clear().unwrap();
        rewind_usage_to_previous_version_four_table(&storage);
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 500.0, "totalChars": 9999 }),
            )
            .unwrap();
        storage
            .set("userStats", &json!({ "totalSessions": 900 }))
            .unwrap();
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let summary = storage.usage_summary(None).unwrap();
        assert_eq!(
            (
                summary.takes,
                summary.total_chars,
                summary.total_duration_sec
            ),
            (0, 0, 0.0),
            "cleared usage must not be re-backfilled from retained history and legacy counters"
        );
        assert_eq!(summary.first_used_at, Some(first_used));
        assert_eq!(storage.history_count(None, false), 1);
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let reopened = storage.usage_summary(None).unwrap();
        assert_eq!((reopened.takes, reopened.total_chars), (0, 0));
        assert_eq!(reopened.first_used_at, Some(first_used));
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn dated_usage_increments_global_and_profile_once_and_clear_reopen_stays_clear() {
        let path = test_db_path("usage-migration-increment");
        let storage = Storage::new(path.clone()).unwrap();
        rewind_usage_to_foreign_version_four(&storage);
        storage
            .set(
                "stats",
                &json!({ "totalChars": 1000, "totalDurationSec": 100.0 }),
            )
            .unwrap();
        storage
            .set(
                "userStats",
                &json!({
                    "totalSessions": 10,
                    "domainWords": { "Code.exe": 700, "Telegram.exe": 300 },
                    "appUsageCount": { "Code.exe": 6, "Telegram.exe": 4 },
                    "firstUsedAt": 1111,
                }),
            )
            .unwrap();
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        let migrated = storage.usage_summary(None).unwrap();
        assert_eq!((migrated.takes, migrated.total_chars), (10, 1000));
        assert_eq!(app(&migrated, "Code.exe"), (6, 700));

        storage
            .usage_record(local_ms(2026, 3, 10, 10, 0), &event(25, 4.0, "Code.exe"))
            .unwrap();
        let all = storage.usage_summary(None).unwrap();
        assert_eq!(
            (all.takes, all.total_chars, all.total_duration_sec),
            (11, 1025, 104.0),
            "a dated record adds its characters to the overall total exactly once"
        );
        assert_eq!(app(&all, "Code.exe"), (7, 725));
        assert_eq!(app(&all, "Telegram.exe"), (4, 300));
        assert_eq!(
            all.max_duration_sec, 4.0,
            "the undated residual duration is not a take"
        );

        let day = storage
            .usage_summary(Some(local_ms(2026, 3, 10, 0, 0)))
            .unwrap();
        assert_eq!(
            (day.takes, day.total_chars, day.total_duration_sec),
            (1, 25, 4.0)
        );

        storage.usage_clear().unwrap();
        drop(storage);
        let storage = Storage::new(path.clone()).unwrap();
        let cleared = storage.usage_summary(None).unwrap();
        assert_eq!((cleared.takes, cleared.total_chars), (0, 0));
        assert_eq!(cleared.first_used_at, Some(1111));
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn format_two_backup_round_trips_profile_chars_and_format_one_reads_as_char_count() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let legacy_row = UsageEventRow {
            ts: None,
            takes: 6,
            char_count: 0,
            duration_sec: 0.0,
            app_id: Some("Code.exe".into()),
            work_mode: None,
            prompt_preset_id: None,
            legacy_profile_chars: Some(700),
        };
        storage
            .usage_restore(Some(&backup_of(vec![legacy_row.clone()], Some(1111))))
            .unwrap();
        let summary = storage.usage_summary(None).unwrap();
        assert_eq!(
            summary.total_chars, 0,
            "the overall total sums char_count only"
        );
        assert_eq!(app(&summary, "Code.exe"), (6, 700));

        let exported = storage.usage_backup().unwrap();
        let value = serde_json::to_value(&exported).unwrap();
        assert_eq!(value["events"][0]["legacyProfileChars"], 700);
        assert_eq!(parse_usage_backup(&value).unwrap(), exported);

        // A format-1 section has no legacyProfileChars: the undated row keeps
        // its original behavior, where charCount fed both calculations.
        let format_one = json!({
            "firstUsedAt": null,
            "events": [{
                "ts": null, "takes": 2, "charCount": 300, "durationSec": 0.0,
                "appId": "Code.exe", "workMode": null, "promptPresetId": null,
            }],
        });
        let parsed = parse_usage_backup(&format_one).unwrap();
        assert_eq!(parsed.events[0].legacy_profile_chars, None);
        storage.usage_restore(Some(&parsed)).unwrap();
        let summary = storage.usage_summary(None).unwrap();
        assert_eq!(summary.total_chars, 300);
        assert_eq!(app(&summary, "Code.exe"), (2, 300));

        for broken in [
            json!({ "ts": 1, "takes": 1, "charCount": 0, "durationSec": 0.0, "appId": "Code.exe", "legacyProfileChars": 5 }),
            json!({ "ts": null, "takes": 1, "charCount": 0, "durationSec": 0.0, "appId": null, "legacyProfileChars": 5 }),
            json!({ "ts": null, "takes": 1, "charCount": 7, "durationSec": 0.0, "appId": "Code.exe", "legacyProfileChars": 5 }),
            json!({ "ts": null, "takes": 1, "charCount": 0, "durationSec": 0.0, "appId": "Code.exe", "legacyProfileChars": -1 }),
        ] {
            let section = json!({ "firstUsedAt": null, "events": [broken] });
            assert!(parse_usage_backup(&section).is_err());
        }

        // The SQL CHECK backs the same rule on the direct restore path: an
        // invalid row aborts the whole replacement and the state stays.
        let before = storage.usage_summary(None).unwrap();
        let invalid = UsageEventRow {
            ts: Some(1),
            takes: 1,
            char_count: 0,
            duration_sec: 0.0,
            app_id: Some("Code.exe".into()),
            work_mode: None,
            prompt_preset_id: None,
            legacy_profile_chars: Some(5),
        };
        assert!(
            storage
                .usage_restore(Some(&backup_of(vec![invalid], None)))
                .is_err()
        );
        assert_eq!(storage.usage_summary(None).unwrap(), before);
    }

    /// One-off check against a supplied, consistent private backup (a
    /// history-disabled database). The source file is never opened writable:
    /// it is copied to a fresh temporary path first and only the copy runs
    /// through `Storage::new`. Run explicitly with the environment variable
    /// set, for example:
    ///   SAYIT_USAGE_MIGRATION_BACKUP=<backup.sqlite3> cargo test --offline \
    ///       supplied_private_backup -- --ignored --nocapture
    /// Prints numeric aggregates only: no settings, app names, or secrets.
    #[test]
    #[ignore = "requires SAYIT_USAGE_MIGRATION_BACKUP pointing to a consistent private backup"]
    fn supplied_private_backup_migrates_to_five_and_preserves_all_usage_aggregates() {
        let source = match std::env::var("SAYIT_USAGE_MIGRATION_BACKUP") {
            Ok(path) if !path.trim().is_empty() => PathBuf::from(path),
            _ => panic!(
                "SAYIT_USAGE_MIGRATION_BACKUP must point to a consistent private backup database"
            ),
        };
        // The clone lives in its own unique directory: migrating it writes the
        // automatic pre-migration snapshot beside it, and that copy of the
        // private fixture must not stay in the shared temporary directory.
        let clone_dir = std::env::temp_dir().join(format!(
            "sayit-supplied-backup-clone-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&clone_dir).expect("temporary clone directory must be creatable");
        let clone_path = clone_dir.join("sayit.db");
        fs::copy(&source, &clone_path)
            .expect("the supplied backup must be copyable to the temporary test path");

        fn read_setting(conn: &Connection, key: &str) -> Option<Value> {
            conn.query_row(
                "SELECT value_json FROM app_settings WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .unwrap()
            .map(|raw| serde_json::from_str(&raw).expect("app_settings JSON must parse"))
        }
        fn raw_count(value: Option<&Value>) -> i64 {
            value
                .and_then(Value::as_f64)
                .map(|count| count.round() as i64)
                .unwrap_or(0)
        }
        fn raw_count_map(value: Option<&Value>) -> BTreeMap<String, i64> {
            value
                .and_then(Value::as_object)
                .map(|object| {
                    object
                        .iter()
                        .map(|(key, count)| (key.clone(), raw_count(Some(count))))
                        .collect()
                })
                .unwrap_or_default()
        }

        let conn =
            Connection::open_with_flags(&clone_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .unwrap();
        let stats = read_setting(&conn, "stats");
        let user_stats = read_setting(&conn, "userStats");
        let expected_chars = raw_count(stats.as_ref().and_then(|value| value.get("totalChars")));
        let expected_duration = stats
            .as_ref()
            .and_then(|value| value.get("totalDurationSec"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let expected_takes = raw_count(
            user_stats
                .as_ref()
                .and_then(|value| value.get("totalSessions")),
        );
        let recorded_app_takes = raw_count_map(
            user_stats
                .as_ref()
                .and_then(|value| value.get("appUsageCount")),
        );
        let recorded_app_chars = raw_count_map(
            user_stats
                .as_ref()
                .and_then(|value| value.get("domainWords")),
        );
        let expected_first_used = user_stats
            .as_ref()
            .and_then(|value| value.get("firstUsedAt"))
            .and_then(Value::as_i64)
            .filter(|ts| *ts > 0);
        let app_keys: BTreeSet<&String> = recorded_app_takes
            .keys()
            .chain(recorded_app_chars.keys())
            .collect();
        let mut expected_apps: BTreeMap<String, (i64, i64)> = BTreeMap::new();
        for key in app_keys {
            let takes = recorded_app_takes.get(key).copied().unwrap_or(0);
            let chars = recorded_app_chars.get(key).copied().unwrap_or(0);
            if takes != 0 || chars != 0 {
                expected_apps.insert(key.clone(), (takes, chars));
            }
        }
        let history_rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM history_records", [], |row| row.get(0))
            .unwrap();
        let marker_four_before: Option<String> = conn
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = 4",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        let usage_table_before: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'usage_events')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        drop(conn);

        assert_eq!(
            history_rows, 0,
            "the supplied backup must have history saving disabled"
        );
        assert!(
            !usage_table_before,
            "the supplied backup must predate the usage table"
        );

        let storage = Storage::new(clone_path.clone()).unwrap();
        let all = storage.usage_summary(None).unwrap();
        assert_eq!(all.total_chars, expected_chars, "overall characters");
        assert_eq!(
            all.total_duration_sec, expected_duration,
            "overall duration"
        );
        assert_eq!(all.takes, expected_takes, "overall takes");
        assert_eq!(all.first_used_at, expected_first_used, "first-use date");
        for (key, (takes, chars)) in &expected_apps {
            assert_eq!(
                app(&all, key),
                (*takes, *chars),
                "profile aggregate of a supplied app"
            );
        }
        assert_eq!(
            all.apps.len(),
            expected_apps.len(),
            "no profile rows beyond the supplied per-app counters"
        );

        let db = storage.db.lock().unwrap();
        let five_count: i64 = db
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations WHERE version = 5",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let marker_four_after: Option<String> = db
            .query_row(
                "SELECT name FROM schema_migrations WHERE version = 4",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        drop(db);
        assert_eq!(five_count, 1, "the usage migration must record version 5");
        assert_eq!(
            marker_four_after, marker_four_before,
            "the version-4 marker must stay unchanged"
        );

        let events = storage.usage_backup().unwrap().events.len();
        println!(
            "supplied backup: totalChars={} totalDurationSec={} takes={} apps={} events={} firstUsedAt={:?}",
            all.total_chars,
            all.total_duration_sec,
            all.takes,
            all.apps.len(),
            events,
            all.first_used_at
        );
        drop(storage);

        let storage = Storage::new(clone_path.clone()).unwrap();
        assert_eq!(
            storage.usage_summary(None).unwrap(),
            all,
            "reopening the migrated copy must be stable"
        );
        drop(storage);
        fs::remove_dir_all(&clone_dir)
            .expect("the temporary clone directory and its snapshots must be removable");
    }

    #[test]
    fn fresh_database_starts_with_no_usage_and_no_legacy_counters() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let summary = storage.usage_summary(None).unwrap();
        assert_eq!((summary.takes, summary.total_chars), (0, 0));
        assert_eq!(summary.first_used_at, None);
        assert_eq!(summary.hour_buckets, vec![0; 24]);
        assert_eq!(storage.get("stats", None), Value::Null);
    }

    #[test]
    fn undated_baseline_stays_out_of_periods_daily_average_and_longest_take() {
        // A history-off user: legacy counters only, no history rows.
        let path = test_db_path("usage-baseline");
        let storage = Storage::new(path.clone()).unwrap();
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 7200.0, "totalChars": 25000 }),
            )
            .unwrap();
        storage
            .set("userStats", &json!({ "totalSessions": 900 }))
            .unwrap();
        rewind_to_pre_usage_schema(&storage);
        drop(storage);

        let storage = Storage::new(path.clone()).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 10, 20), &event(30, 12.0, "Code.exe"))
            .unwrap();

        let all = storage.usage_summary(None).unwrap();
        assert_eq!((all.takes, all.total_chars), (901, 25030));
        assert_eq!((all.dated_takes, all.dated_chars), (1, 30));
        assert_eq!(
            all.max_duration_sec, 12.0,
            "the 7200 s baseline row is not a take"
        );
        assert_eq!(all.active_days, 1);
        assert_eq!(all.hour_buckets[10], 1);
        assert_eq!(all.hour_buckets.iter().sum::<i64>(), 1);

        let day = storage
            .usage_summary(Some(local_ms(2026, 3, 10, 0, 0)))
            .unwrap();
        assert_eq!(
            (day.takes, day.total_chars, day.total_duration_sec),
            (1, 30, 12.0)
        );
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn record_floors_timestamp_trims_blank_fields_and_keeps_first_use_date() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let blank_app = UsageEventInput {
            char_count: 5,
            duration_sec: 1.0,
            app_id: Some("   ".to_string()),
            work_mode: Some("local".to_string()),
            prompt_preset_id: None,
        };
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 7) + 31_000, &blank_app)
            .unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 11, 0), &event(7, 2.0, "Code.exe"))
            .unwrap();

        let backup = storage.usage_backup().unwrap();
        assert_eq!(backup.events[0].ts, Some(local_ms(2026, 3, 10, 9, 0)));
        assert_eq!(backup.events[0].app_id, None);
        assert_eq!(backup.first_used_at, Some(local_ms(2026, 3, 10, 9, 0)));
    }

    #[test]
    fn clear_removes_rows_but_keeps_first_use_date() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        storage.usage_clear().unwrap();

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!((summary.takes, summary.total_chars), (0, 0));
        assert_eq!(summary.first_used_at, Some(local_ms(2026, 3, 10, 9, 0)));
    }

    #[test]
    fn concurrent_records_accumulate_without_loss() {
        let path = test_db_path("usage-concurrent");
        let storage = std::sync::Arc::new(Storage::new(path.clone()).unwrap());
        let at = local_ms(2026, 3, 10, 9, 0);
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let storage = std::sync::Arc::clone(&storage);
                std::thread::spawn(move || {
                    storage
                        .usage_record(at, &event(5, 0.5, "Code.exe"))
                        .unwrap()
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!(
            (
                summary.takes,
                summary.total_chars,
                summary.total_duration_sec
            ),
            (8, 40, 4.0)
        );
        drop(storage);
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn event_validation_rejects_negative_and_non_finite_values() {
        assert!(event(-1, 1.0, "a").validate().is_err());
        assert!(event(0, -0.5, "a").validate().is_err());
        assert!(event(0, f64::NAN, "a").validate().is_err());
        assert!(event(0, f64::INFINITY, "a").validate().is_err());
        assert!(event(0, 0.0, "a").validate().is_ok());
        assert!(event(5, 1.5, "a").validate().is_ok());
    }

    fn backup_of(events: Vec<UsageEventRow>, first_used_at: Option<i64>) -> UsageBackup {
        UsageBackup {
            first_used_at,
            events,
        }
    }

    fn dated_row(ts: i64, char_count: i64) -> UsageEventRow {
        UsageEventRow {
            ts: Some(ts),
            takes: 1,
            char_count,
            duration_sec: 1.0,
            app_id: Some("Code.exe".into()),
            work_mode: None,
            prompt_preset_id: None,
            legacy_profile_chars: None,
        }
    }

    #[test]
    fn restore_with_section_replaces_local_usage_and_drops_legacy_counters() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        // appSettings from the backup are applied before usage and may carry old counters.
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 50.0, "totalChars": 999 }),
            )
            .unwrap();

        let first = local_ms(2025, 1, 2, 8, 0);
        storage
            .usage_restore(Some(&backup_of(
                vec![dated_row(local_ms(2025, 1, 2, 8, 0), 42)],
                Some(first),
            )))
            .unwrap();

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!((summary.takes, summary.total_chars), (1, 42));
        assert_eq!(summary.first_used_at, Some(first));
        assert_eq!(storage.get("stats", None), Value::Null);
    }

    #[test]
    fn restoring_an_empty_section_after_clear_does_not_resurrect_legacy_counters() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        storage.usage_clear().unwrap();
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 50.0, "totalChars": 999 }),
            )
            .unwrap();
        storage
            .set("userStats", &json!({ "totalSessions": 40 }))
            .unwrap();

        storage
            .usage_restore(Some(&backup_of(Vec::new(), None)))
            .unwrap();

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!((summary.takes, summary.total_chars), (0, 0));
        assert_eq!(summary.first_used_at, None);
        assert_eq!(storage.get("userStats", None), Value::Null);
    }

    #[test]
    fn restore_without_section_keeps_local_usage() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 50.0, "totalChars": 999 }),
            )
            .unwrap();

        storage.usage_restore(None).unwrap();

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!((summary.takes, summary.total_chars), (1, 5));
        assert_eq!(storage.get("stats", None), Value::Null);
    }

    #[test]
    fn restore_without_section_rebuilds_when_local_usage_is_empty() {
        // An old backup restored onto a fresh machine: history and legacy
        // counters arrive, usage events do not.
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .set(
                "history",
                &json!([{ "id": "h1", "timestamp": local_ms(2026, 3, 10, 9, 0), "charCount": 30, "durationSec": 2.0 }]),
            )
            .unwrap();
        storage
            .set(
                "stats",
                &json!({ "totalDurationSec": 20.0, "totalChars": 500 }),
            )
            .unwrap();
        storage
            .set("userStats", &json!({ "totalSessions": 10 }))
            .unwrap();

        storage.usage_restore(None).unwrap();

        let summary = storage.usage_summary(None).unwrap();
        assert_eq!(
            (
                summary.takes,
                summary.total_chars,
                summary.total_duration_sec
            ),
            (10, 500, 20.0)
        );
        assert_eq!(summary.dated_takes, 1);
    }

    #[test]
    fn backup_round_trips_and_rejects_negative_values() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        let exported = storage.usage_backup().unwrap();
        let value = serde_json::to_value(&exported).unwrap();
        assert_eq!(value["events"][0]["charCount"], 5);
        assert_eq!(parse_usage_backup(&value).unwrap(), exported);

        let mut broken = value.clone();
        broken["events"][0]["charCount"] = json!(-3);
        assert!(parse_usage_backup(&broken).is_err());
        assert!(parse_usage_backup(&json!({ "events": "nope" })).is_err());
    }

    #[test]
    fn restore_rejects_invalid_row_without_mutating_existing_usage() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        let original = event(5, 1.0, "Code.exe");
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &original)
            .unwrap();
        let invalid = UsageEventRow {
            ts: Some(local_ms(2026, 3, 10, 10, 0)),
            takes: 1,
            char_count: -1,
            duration_sec: 1.0,
            app_id: None,
            work_mode: None,
            prompt_preset_id: None,
            legacy_profile_chars: None,
        };

        assert!(
            storage
                .usage_restore(Some(&backup_of(vec![invalid], None)))
                .is_err()
        );
        let summary = storage.usage_summary(None).unwrap();
        assert_eq!((summary.takes, summary.total_chars), (1, 5));
    }

    #[test]
    fn corrupt_first_use_metadata_returns_an_error() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .db
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO db_meta (key, value_json, updated_at) VALUES ('usage_first_used_at', 'not-a-timestamp', 0)",
                [],
            )
            .unwrap();

        assert!(storage.usage_summary(None).is_err());
        assert!(storage.usage_backup().is_err());
    }

    #[test]
    fn history_operations_never_change_usage() {
        let storage = Storage::new(PathBuf::from(":memory:")).unwrap();
        storage
            .usage_record(local_ms(2026, 3, 10, 9, 0), &event(5, 1.0, "Code.exe"))
            .unwrap();
        let before = storage.usage_summary(None).unwrap();

        storage
            .history_add(&json!({ "id": "h1", "timestamp": 1, "charCount": 7, "durationSec": 2.0 }))
            .unwrap();
        storage
            .history_add(&json!({ "id": "h2", "timestamp": 2, "charCount": 3, "durationSec": 1.0 }))
            .unwrap();
        storage
            .history_update("h1", &json!({ "charCount": 0, "isEmpty": true }))
            .unwrap();
        storage.history_delete("h2").unwrap();
        storage.history_clear().unwrap();

        assert_eq!(storage.usage_summary(None).unwrap(), before);
        assert_eq!(
            storage.get("stats", None),
            Value::Null,
            "history must no longer write the legacy counters"
        );
    }
}

-- Anonymous usage log: one row per completed dictation, written whether or not
-- history saving is on. Rows never hold text, audio paths, window titles, or
-- preset names.
--
-- ts: UTC milliseconds floored to 15 minutes. NULL marks the undated baseline
-- carried over from the legacy counters; it counts toward all-time totals only.
-- takes: dictations the row stands for (1 for live events, N for baseline rows).
--
-- legacy_profile_chars: historical per-app characters carried over from the
-- legacy `domainWords` counter, which accumulated independently of the overall
-- `totalChars` total. The rows holding it are undated, app-attributed baseline
-- rows with char_count = 0; live and dated rows never set it. The per-app
-- personalization profile uses it in place of char_count, so the overall total
-- is not inflated by profile characters that were never part of it.
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY,
  ts INTEGER,
  takes INTEGER NOT NULL DEFAULT 1 CHECK (takes >= 0),
  char_count INTEGER NOT NULL DEFAULT 0 CHECK (char_count >= 0),
  duration_sec REAL NOT NULL DEFAULT 0 CHECK (duration_sec >= 0),
  app_id TEXT,
  work_mode TEXT,
  prompt_preset_id TEXT,
  legacy_profile_chars INTEGER CHECK (
    legacy_profile_chars IS NULL OR (
      ts IS NULL AND app_id IS NOT NULL AND char_count = 0 AND legacy_profile_chars >= 0
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);

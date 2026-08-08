-- D1 schema for euro-dollar-bot. Schema version 4 (new start, не таскаем legacy v1/v2/v3 migrations).
-- Canonical D1 schema; architectural context lives in docs/architecture.md.

PRAGMA foreign_keys = ON;

-- ============ Users ============
CREATE TABLE users (
  chat_id            INTEGER PRIMARY KEY,
  role               TEXT    NOT NULL CHECK (role IN ('owner','member')),
  name               TEXT,
  joined_at          TEXT    NOT NULL,
  silence_active     INTEGER NOT NULL DEFAULT 0 CHECK (silence_active IN (0,1)),
  silence_until      TEXT,
  silence_reason     TEXT,
  quiet_enabled      INTEGER NOT NULL DEFAULT 0 CHECK (quiet_enabled IN (0,1)),
  quiet_from_hour    INTEGER NOT NULL DEFAULT 23 CHECK (quiet_from_hour BETWEEN 0 AND 23),
  quiet_to_hour      INTEGER NOT NULL DEFAULT 7  CHECK (quiet_to_hour   BETWEEN 0 AND 23),
  digest_enabled     INTEGER NOT NULL DEFAULT 1 CHECK (digest_enabled IN (0,1))
);

-- ============ Bot state (singleton) ============
CREATE TABLE bot_state (
  id                              INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version                  INTEGER NOT NULL DEFAULT 4,
  last_update_id                  INTEGER NOT NULL DEFAULT 0,
  menu_set_at                     TEXT,
  menu_commands_count             INTEGER NOT NULL DEFAULT 0,
  baseline_rolling_median_30d     REAL,
  baseline_rolling_p90_90d        REAL,
  baseline_computed_at            TEXT,
  quota_credits_used_today        INTEGER NOT NULL DEFAULT 0,
  quota_reset_at                  TEXT,
  consecutive_failures            INTEGER NOT NULL DEFAULT 0,
  last_alert_json                 TEXT,
  last_score_breakdown_json       TEXT,
  last_digest_at                  TEXT,
  budget_target_eur               REAL,
  budget_deadline                 TEXT,
  budget_started_at               TEXT,
  budget_converted_eur            REAL NOT NULL DEFAULT 0,
  budget_converted_usd            REAL NOT NULL DEFAULT 0
);
INSERT INTO bot_state (id) VALUES (1);

-- ============ Alert history (append-only) ============
CREATE TABLE alert_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        TEXT    NOT NULL,
  regime    TEXT    NOT NULL,
  score     REAL    NOT NULL,
  rate      REAL    NOT NULL,
  edge_pct  REAL    NOT NULL DEFAULT 0
);
CREATE INDEX idx_alert_history_ts ON alert_history(ts);

-- ============ Conversions (budget done log) ============
CREATE TABLE conversions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  eur             REAL    NOT NULL,
  rate            REAL    NOT NULL,
  pct_at_alert    INTEGER
);

-- ============ Events (FOMC/ECB/NFP/CPI blackout calendar) ============
CREATE TABLE events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT    NOT NULL,
  type            TEXT    NOT NULL,
  description     TEXT
);
CREATE INDEX idx_events_ts ON events(ts);

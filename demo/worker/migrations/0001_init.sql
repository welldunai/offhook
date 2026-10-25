-- Demo sessions and the waitlist (DEMO.md). Sessions are deleted 24 hours after creation.

CREATE TABLE demo_sessions (
  id          TEXT PRIMARY KEY,                -- random UUID
  created_at  INTEGER NOT NULL,                -- unix ms
  expires_at  INTEGER NOT NULL,                -- created_at + 24h; the hourly cron deletes after this
  status      TEXT NOT NULL CHECK (status IN ('created', 'live', 'completed', 'failed', 'expired')),
  use_case    TEXT,                            -- launch use case slug, or NULL for a custom plan
  plan        TEXT NOT NULL,                   -- JSON Plan the agent runs
  visitor     TEXT NOT NULL,                   -- hashed visitor key, never a raw IP
  started_at  INTEGER,
  ended_at    INTEGER,
  end_reason  TEXT,                            -- hung_up, time_limit, silence, error
  transcript  TEXT,                            -- JSON [{who, text, at_ms}]
  outcome     TEXT,                            -- JSON {field_key: value}
  summary     TEXT,
  latency     TEXT                             -- JSON per-turn response times in ms
);
CREATE INDEX demo_sessions_expires_at ON demo_sessions (expires_at);

CREATE TABLE waitlist_entries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  email       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  company     TEXT,
  use_case    TEXT,
  created_at  INTEGER NOT NULL
);

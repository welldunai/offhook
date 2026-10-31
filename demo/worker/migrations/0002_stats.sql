-- Stats that outlive the 24-hour window (see src/cleanup.ts).
-- One row per plan a visitor asked for; the purpose text isn't kept.
CREATE TABLE plan_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,                -- unix ms
  visitor     TEXT NOT NULL,                   -- hashed visitor key (salted per day), never a raw IP
  outcome     TEXT NOT NULL CHECK (outcome IN ('planned', 'refused', 'failed', 'limited'))
);
CREATE INDEX plan_requests_created_at ON plan_requests (created_at);
CREATE INDEX demo_sessions_created_at ON demo_sessions (created_at);

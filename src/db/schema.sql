-- Article Platform schema
--
-- Two principles drive this design, both learned from the n8n/Sheets system
-- it replaces:
--
--  1. Derived facts are never stored. today_count, last_publish, error_count
--     are all computed from `runs`. A stored counter can drift from reality,
--     be incremented as a string ("3" + 1 = "31"), or be lost to a concurrent
--     write. A query cannot.
--
--  2. Invalid states are made unrepresentable. The old SPY sheet had a column
--     per domain, which allowed duplicate columns for the same site holding
--     contradictory values. Here the matrix is rows with a UNIQUE constraint,
--     so that state cannot be written at all.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Sites (replaces the KEYS sheet)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sites (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  domain         TEXT    NOT NULL UNIQUE,
  status         TEXT    NOT NULL DEFAULT 'paused'
                         CHECK (status IN ('active', 'paused')),
  pin_username   TEXT    NOT NULL DEFAULT '',
  project_id     TEXT    NOT NULL DEFAULT '',

  -- Credentials are per site: every domain has its own publishing token and
  -- its own Buffer account. Encrypted at rest with ENCRYPTION_KEY.
  api_token_encrypted    TEXT NOT NULL DEFAULT '',
  buffer_token_encrypted TEXT NOT NULL DEFAULT '',

  daily_target   INTEGER NOT NULL DEFAULT 0 CHECK (daily_target >= 0),

  -- Minimum gap between posts, in minutes. Stored as minutes rather than
  -- hours so any cadence is expressible: 20 minutes, 90 minutes, 3 days.
  interval_minutes INTEGER NOT NULL DEFAULT 480 CHECK (interval_minutes >= 0),

  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Keywords (replaces the SPY DATA sheet's fixed columns)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keywords (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  seed_keyword     TEXT    NOT NULL,
  spy_title        TEXT    NOT NULL DEFAULT '',
  spy_description  TEXT    NOT NULL DEFAULT '',
  spy_image_url    TEXT    NOT NULL DEFAULT '',
  spy_article_url  TEXT    NOT NULL DEFAULT '',
  spy_pin_image    TEXT    NOT NULL DEFAULT '',
  annotation       TEXT    NOT NULL DEFAULT '',
  status           TEXT    NOT NULL DEFAULT 'go'
                           CHECK (status IN ('go', 'done', 'no')),
  created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_keywords_status ON keywords (status);

-- ---------------------------------------------------------------------------
-- Keyword x Site matrix (replaces the column-per-domain grid)
--
-- The UNIQUE constraint is the whole point: the old sheet had bitespoon.com
-- as two separate columns that could disagree with each other, which made a
-- keyword look permanently eligible and drove an infinite loop. Here that
-- state is rejected by the database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS keyword_sites (
  keyword_id  INTEGER NOT NULL REFERENCES keywords (id) ON DELETE CASCADE,
  site_id     INTEGER NOT NULL REFERENCES sites (id)    ON DELETE CASCADE,
  status      TEXT    NOT NULL DEFAULT 'no'
                      CHECK (status IN ('go', 'done', 'no')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (keyword_id, site_id)
);
CREATE INDEX IF NOT EXISTS idx_ks_site_status ON keyword_sites (site_id, status);

-- ---------------------------------------------------------------------------
-- Runs: one publishing attempt. The source of truth for every derived counter.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  keyword_id    INTEGER REFERENCES keywords (id) ON DELETE SET NULL,
  site_id       INTEGER REFERENCES sites (id)    ON DELETE SET NULL,
  status        TEXT    NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'published', 'failed', 'cancelled')),
  started_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  published_at  TEXT,
  post_id       TEXT,
  post_url      TEXT,
  error         TEXT,
  failed_step   TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_site_pub ON runs (site_id, published_at);
CREATE INDEX IF NOT EXISTS idx_runs_status   ON runs (status);
CREATE INDEX IF NOT EXISTS idx_runs_started  ON runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Run steps: checkpoints AND the debugging surface.
--
-- A completed row here means the step is skipped on resume and its stored
-- output is reused, so a failure at step 12 does not repay 13 LLM calls.
-- The same rows drive the run detail page in the UI.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS run_steps (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id      INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  step        TEXT    NOT NULL,
  status      TEXT    NOT NULL CHECK (status IN ('running', 'ok', 'failed', 'skipped')),
  attempt     INTEGER NOT NULL DEFAULT 1,
  started_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  endpoint    TEXT,             -- which Ollama endpoint served this step
  model       TEXT,
  input_json  TEXT,
  output_json TEXT,
  error       TEXT,
  UNIQUE (run_id, step)
);
CREATE INDEX IF NOT EXISTS idx_steps_run ON run_steps (run_id);

-- ---------------------------------------------------------------------------
-- Decisions: every accept / reject / skip with its reason.
-- Implements sections 16 and 17 of the specification.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS decisions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cycle_id      TEXT    NOT NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  subject_type  TEXT    NOT NULL CHECK (subject_type IN ('site', 'keyword', 'pair', 'cycle')),
  subject_id    INTEGER,
  subject_label TEXT    NOT NULL DEFAULT '',
  decision      TEXT    NOT NULL CHECK (decision IN ('selected', 'eligible', 'rejected', 'skipped', 'none')),
  reason        TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_decisions_cycle   ON decisions (cycle_id);
CREATE INDEX IF NOT EXISTS idx_decisions_created ON decisions (created_at DESC);

-- ---------------------------------------------------------------------------
-- Settings: everything that used to live in .env or be hardcoded in nodes.
-- Values flagged `secret` are encrypted at rest with ENCRYPTION_KEY.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  is_secret  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- LLM endpoint pool. Replaces nine hand-pinned Ollama credentials.
-- `models` is a JSON array of model names this endpoint can serve.
-- ---------------------------------------------------------------------------
-- One row per API KEY, not per server. All keys share the base URL held in
-- settings (`llm_base_url`), because the provider is one cloud endpoint; the
-- keys exist only to spread its rate limit. base_url stays per-row so a
-- self-hosted instance can be mixed in later, but is blank in normal use.
CREATE TABLE IF NOT EXISTS llm_endpoints (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL UNIQUE,
  base_url          TEXT    NOT NULL DEFAULT '',
  api_key_encrypted TEXT    NOT NULL DEFAULT '',
  models            TEXT    NOT NULL DEFAULT '[]',
  enabled           INTEGER NOT NULL DEFAULT 1,
  -- health, maintained by the pool at runtime
  healthy           INTEGER NOT NULL DEFAULT 1,
  consecutive_fails INTEGER NOT NULL DEFAULT 0,
  cooldown_until    TEXT,
  last_used_at      TEXT,
  last_success_at   TEXT,
  last_error        TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- Scheduler lock: one row, one job at a time. This single row is the entire
-- concurrency control story, and why overlapping-execution races cannot occur.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scheduler_lock (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  run_id      INTEGER REFERENCES runs (id) ON DELETE SET NULL,
  locked_at   TEXT,
  heartbeat_at TEXT
);
INSERT OR IGNORE INTO scheduler_lock (id, run_id, locked_at) VALUES (1, NULL, NULL);

-- ---------------------------------------------------------------------------
-- Application event log (technical errors, scheduler activity)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  level      TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
  source     TEXT NOT NULL DEFAULT '',
  message    TEXT NOT NULL,
  detail     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events (created_at DESC);

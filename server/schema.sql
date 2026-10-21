-- Executed only by initialization/migration tooling, never inside API requests.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations = 100000),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_by_expiration ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  data TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1 AND version <= 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS events_by_user ON events(user_id, created_at, id);

-- Fixed-window counters are shared by SQLite processes / D1 Worker instances.
-- Bucket keys hash IP + optional username; raw IP addresses are not retained.
CREATE TABLE IF NOT EXISTS auth_attempts (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);
CREATE INDEX IF NOT EXISTS attempts_by_window ON auth_attempts(window_start);

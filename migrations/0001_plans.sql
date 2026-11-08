CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  is_default INTEGER NOT NULL DEFAULT 0,
  tables_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS plans_default_idx ON plans (is_default);

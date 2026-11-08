CREATE TABLE IF NOT EXISTS refresh_runs (
  id TEXT PRIMARY KEY,
  snapshot_timestamp TEXT NOT NULL,
  current_index INTEGER NOT NULL,
  status TEXT NOT NULL,
  current_run_id INTEGER,
  workflows_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT
);
CREATE INDEX IF NOT EXISTS refresh_runs_updated_idx ON refresh_runs(updated_at);

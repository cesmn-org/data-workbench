ALTER TABLE refresh_runs ADD COLUMN dispatch_started_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS refresh_runs_one_active_idx
  ON refresh_runs (1)
  WHERE status IN ('queued', 'running');

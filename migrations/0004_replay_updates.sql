CREATE TABLE minute_updates (
  observed_at INTEGER PRIMARY KEY,
  previous_source_updated_at INTEGER NOT NULL,
  source_updated_at INTEGER NOT NULL UNIQUE,
  payload TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX minute_snapshots_source_updated_at
ON minute_snapshots (source_updated_at, observed_at);

CREATE TABLE system_state (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE completed_rollups (
  bucket_at INTEGER PRIMARY KEY,
  completed_at INTEGER NOT NULL
);

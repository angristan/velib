CREATE TABLE station_rollup_archive_days (
  day_at INTEGER PRIMARY KEY,
  enqueued_at INTEGER NOT NULL,
  completed_at INTEGER
) WITHOUT ROWID;

CREATE TABLE station_rollup_archive_jobs (
  day_at INTEGER NOT NULL,
  station_code INTEGER NOT NULL,
  payload TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER,
  PRIMARY KEY (day_at, station_code)
) WITHOUT ROWID;

CREATE INDEX station_rollup_archive_jobs_due
ON station_rollup_archive_jobs (next_attempt_at, day_at, station_code);

CREATE TABLE station_rollup_archive_objects (
  station_code INTEGER NOT NULL,
  month_at INTEGER NOT NULL,
  complete_through INTEGER NOT NULL,
  etag TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (station_code, month_at)
) WITHOUT ROWID;

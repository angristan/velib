CREATE TABLE station_rollup_buckets_5m (
  bucket_at INTEGER NOT NULL,
  shard INTEGER NOT NULL,
  payload BLOB NOT NULL,
  PRIMARY KEY (bucket_at, shard)
) WITHOUT ROWID;

CREATE TABLE station_history_archives (
  station_code INTEGER NOT NULL,
  month_at INTEGER NOT NULL,
  complete_through INTEGER NOT NULL,
  payload BLOB NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (station_code, month_at)
) WITHOUT ROWID;

PRAGMA foreign_keys = ON;

CREATE TABLE stations (
  station_code INTEGER PRIMARY KEY,
  station_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  capacity INTEGER NOT NULL,
  metadata_updated_at INTEGER NOT NULL
);

CREATE TABLE latest_status (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  observed_at INTEGER NOT NULL,
  source_updated_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE minute_snapshots (
  observed_at INTEGER PRIMARY KEY,
  source_updated_at INTEGER NOT NULL,
  station_count INTEGER NOT NULL,
  payload BLOB NOT NULL
);

CREATE TABLE station_rollups_5m (
  station_code INTEGER NOT NULL,
  bucket_at INTEGER NOT NULL,
  sample_count INTEGER NOT NULL,
  mechanical_min INTEGER NOT NULL,
  mechanical_max INTEGER NOT NULL,
  mechanical_avg REAL NOT NULL,
  mechanical_removed INTEGER NOT NULL,
  mechanical_returned INTEGER NOT NULL,
  electric_min INTEGER NOT NULL,
  electric_max INTEGER NOT NULL,
  electric_avg REAL NOT NULL,
  electric_removed INTEGER NOT NULL,
  electric_returned INTEGER NOT NULL,
  docks_min INTEGER NOT NULL,
  docks_max INTEGER NOT NULL,
  docks_avg REAL NOT NULL,
  unavailable_min INTEGER NOT NULL,
  unavailable_max INTEGER NOT NULL,
  unavailable_avg REAL NOT NULL,
  operative_samples INTEGER NOT NULL,
  PRIMARY KEY (station_code, bucket_at)
) WITHOUT ROWID;

CREATE TABLE network_rollups_5m (
  bucket_at INTEGER PRIMARY KEY,
  payload TEXT NOT NULL
);

CREATE TABLE collection_runs (
  observed_at INTEGER PRIMARY KEY,
  source_updated_at INTEGER,
  station_count INTEGER,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'stale', 'error')),
  message TEXT
);

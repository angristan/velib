CREATE TABLE station_observation_outbox (
  observed_at INTEGER PRIMARY KEY,
  source_updated_at INTEGER NOT NULL,
  capacities TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_attempt_at INTEGER
) WITHOUT ROWID;

CREATE INDEX station_observation_outbox_due
ON station_observation_outbox (next_attempt_at, observed_at);

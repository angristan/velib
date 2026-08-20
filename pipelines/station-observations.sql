INSERT INTO velib_station_observations_catalog_v1
SELECT
  event_id,
  observed_at,
  source_updated_at,
  bucket_at,
  station_code,
  capacity,
  mechanical,
  electric,
  docks,
  unavailable,
  operative,
  last_reported_at
FROM velib_station_observations_stream_v1;

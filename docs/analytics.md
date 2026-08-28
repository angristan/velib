# Analytics and long-term history

D1 remains authoritative for collection, live state, replay, and the hot seven-day window. R2 has two separate roles: immutable raw observations for offline analysis and compact rollup objects for fast long-range charts.

```text
minute collection
   ├── D1 snapshots + 5-minute rollups ──▶ live, replay, 1h/3h/1d/7d
   ├── Pipeline ──▶ Iceberg raw observations ──▶ offline R2 SQL
   └── bounded daily exporter ──▶ monthly R2 rollup objects ──▶ 30d/1y
```

R2 SQL is intentionally not in the interactive request path. Production benchmarks of station-scoped SQL varied from about 3 to 12 seconds, including repeated cached queries. Direct R2 object reads provide a bounded serving path instead.

## Raw archive

Durable account resources belong in `cloudflare-tf`:

- R2 bucket: `velib-analytics`
- Data Catalog namespace: `velib`
- Iceberg table: `station_observations_v1`
- Pipeline stream: `velib_station_observations_stream_v1`
- Pipeline sink: `velib_station_observations_catalog_v1`
- Pipeline: `velib_station_observations_v1`

The Worker owns the `OBSERVATIONS` Pipeline binding and the `HISTORY_ROLLUPS` R2 bucket binding in `wrangler.jsonc`.

A successful minute snapshot and its immutable capacity map enter `station_observation_outbox` in the same D1 batch. Scheduled work leases at most three entries, retries Pipeline acceptance, and deletes an entry only after acceptance. Deterministic `event_id` values make ambiguous retries safe; offline SQL must deduplicate by `event_id` and latest `__ingest_ts`.

Pipeline failure never fails authoritative D1 collection. Raw observations are for repair, export, and exceptional analysis—not normal page loads.

## Precomputed rollup objects

Each station has one gzip JSON object per UTC calendar month:

```text
rollups/v1/stations/{station-code}/{month-start-unix}.json.gz
```

The versioned object contains compact one-hour aggregates. The API returns:

| Range | Source | Resolution |
| --- | --- | ---: |
| `1h` | D1 minute snapshots | 1 minute |
| `3h`, `1d`, `7d` | D1 station rollups | 5 minutes |
| `30d` | monthly R2 objects plus D1 overlap | 1 hour |
| `1y` | monthly R2 objects plus D1 overlap | 6 hours |

D1 wins for overlapping timestamps. This keeps current data fresh while the current-month object is updated and lets object export lag without creating a chart gap.

## Durable generation

Migration `0006_station_rollup_archive.sql` adds day markers and a leased job queue. At minute 15 of every UTC hour, the Worker reconciles the six most recent complete days; day markers make repeated scheduling idempotent.

Each scheduled invocation:

1. Captures up to 25 station/day payloads from retained D1 five-minute rollups.
2. Persists the compact hourly payload in the D1 job before external I/O.
3. Delivers up to eight prepared jobs to R2.
4. Reads and validates the station-month object.
5. Replaces that day and conditionally writes the new object by ETag.
6. Deletes the job only after the R2 write succeeds.

Preparation and delivery failures use bounded exponential backoff. Prepared payloads survive D1 hot-history cleanup and Worker interruption. Jobs for the same station are delivered in day order. A crash after R2 write but before D1 completion is safe because replacing the same day is idempotent.

Monitor pending/unprepared jobs, oldest job age, retries, object write conflicts, and completed day markers. Object generation failure must not affect collection, Pipeline delivery, or live broadcasts.

## Cost and CPU

At 1,519 stations, raw Pipeline input is about 16.7 GB/month, below the Workers Paid 50 GB transform and sink allowances. Hourly monthly objects are small; one-year direct-object history is expected to remain below the standard R2 storage allowance when it is available.

D1 five-minute rollups remain enabled. This design optimizes serving latency and one-year retention, not Cron CPU. The measured Pipeline archive run rate was about 6.7 million Cron CPU-ms/month, below the account's 30 million included CPU-ms.

## Retention

The intended retention is one year.

- A future R2 lifecycle rule may expire only `rollups/v1/` objects after a reviewed safety margin such as 400 days.
- Never apply a bucket lifecycle rule to Iceberg data or metadata paths.
- Raw-table retention requires an Iceberg transaction that deletes rows by `observed_at`, followed by catalog snapshot expiration and compaction. Direct object deletion can corrupt the table.

No destructive retention action is enabled by this application change. Review the exact lifecycle prefix and Iceberg maintenance plan before enabling deletion.

## Rollback

Removing the `HISTORY_ROLLUPS` binding or tiered history deployment removes `30d` and `1y` serving but does not affect D1 collection or the existing hot history. Keep D1 rollups enabled throughout rollback. Do not delete R2 objects, raw observations, or D1 archive jobs as part of a code rollback.

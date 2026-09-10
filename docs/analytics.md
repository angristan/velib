# Analytics and history

D1 is authoritative for collection, live state, replay, and every chart range. The Worker no longer sends raw observations to Cloudflare Pipelines or writes new history objects to R2.

```text
minute collection
   ├── D1 snapshots ──▶ live, replay, 1h
   ├── sharded 5-minute D1 buckets ──▶ 3h, 1d, 7d
   └── daily station archive jobs ──▶ monthly D1 archives ──▶ 30d, 1y
```

## History ranges

| Range | Source | Resolution |
| --- | --- | ---: |
| `1h` | D1 minute snapshots | 1 minute |
| `3h`, `1d`, `7d` | D1 five-minute buckets | 5 minutes |
| `30d` | monthly D1 archives plus five-minute overlap | 1 hour |
| `1y` | monthly D1 archives plus five-minute overlap | 6 hours |

D1 five-minute data wins for overlapping timestamps. This keeps current data fresh while the completed-day archive catches up.

## Packed five-minute buckets

Migration `0007_station_history_archives.sql` adds `station_rollup_buckets_5m`. Each five-minute collection writes at most 16 gzip-compressed shard rows instead of one `station_rollups_5m` row per station. A station always maps to the same shard, so a history request reads only that shard.

The Worker reads both formats during the seven-day transition. Existing `station_rollups_5m` rows expire through the normal cleanup path. New collections write only the packed format.

At 1,519 stations, this changes the main history path from about 437,000 station-row writes per day to at most 4,608 shard-row writes per day. Network rollups, completion markers, snapshots, and collection metadata remain separate D1 writes.

## Monthly station archives

`station_history_archives` stores one gzip-compressed JSON payload per station and UTC month. Each payload contains hourly points and a completion boundary.

The existing durable job tables still protect daily generation:

1. The Worker reconciles the six most recent completed UTC days.
2. A job reads that station's packed or legacy five-minute points for one day.
3. It aggregates the points to one-hour resolution and stores the prepared payload in D1.
4. It replaces that day in the station's monthly D1 archive.
5. It deletes the job only after the archive row is committed.

Preparation and delivery use bounded retries. Replacing one day is idempotent. Archive failures do not stop collection or live broadcasts.

At 00:15 UTC, the Worker removes archive months older than the month containing the one-year cutoff. Keeping the cutoff month prevents a gap at the start of the `1y` range.

## Retained R2 resources

The existing `velib-analytics` bucket, Data Catalog table, Pipeline resources, and stored data remain in `cloudflare-tf`. The application does not delete or mutate them.

The rollout copied and validated every existing monthly rollup into `station_history_archives` before removing the `HISTORY_ROLLUPS` binding. Infrastructure and data deletion require a separate reviewed operation.

Do not add a generic lifecycle rule to `velib-analytics`. The bucket contains Iceberg data and metadata; direct object expiry can corrupt the table.

## Rollback

A code rollback can read the retained R2 rollups and existing legacy D1 rows. Do not delete packed buckets, D1 archives, R2 objects, or archive manifests as part of rollback.

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

Migration `0007_station_history_archives.sql` adds `station_rollup_buckets_5m`. Each five-minute collection writes at most 16 gzip-compressed shard rows instead of one row per station. A station always maps to the same shard, so a history request reads only that shard.

Migration `0008_drop_legacy_analytics.sql` removes the old per-station rollups, observation outbox, and R2 archive manifests. The `3h`, `1d`, and `7d` ranges contain only packed data collected after the D1-only rollout, so the longer recent ranges refill over seven days.

At 1,519 stations, this changes the main history path from about 437,000 station-row writes per day to at most 4,608 shard-row writes per day. Network rollups, completion markers, snapshots, and collection metadata remain separate D1 writes.

## Monthly station archives

`station_history_archives` stores one gzip-compressed JSON payload per station and UTC month. Each payload contains hourly points and a completion boundary.

The existing durable job tables still protect daily generation:

1. The Worker reconciles the six most recent completed UTC days.
2. The Worker claims preparation jobs by day and shard, then reads and decodes each group's five-minute buckets once.
3. It aggregates each station's points to one-hour resolution and stores a separate prepared payload in D1.
4. It replaces that day in the station's monthly D1 archive.
5. It deletes the job only after the archive row is committed.

Shared source points stay within one maintenance invocation. A later invocation rereads D1, so corrected source buckets are not hidden by a warm cache. A corrupt source retries only the jobs in its day-and-shard group; other groups continue.

Preparation and delivery use bounded retries. Replacing one day is idempotent. Archive failures do not stop collection or live broadcasts.

At 00:15 UTC, the Worker removes archive months older than the month containing the one-year cutoff. Keeping the cutoff month prevents a gap at the start of the `1y` range.

## Removed legacy storage

The rollout copied and validated every monthly R2 rollup into `station_history_archives`. The Pipeline, Data Catalog, R2 bucket, stored R2 data, observation outbox, R2 archive manifests, and per-station five-minute table have since been removed.

## Rollback

Migration `0008_drop_legacy_analytics.sql` is a contract migration. Worker versions that query the removed tables cannot run after it is applied. Roll back only to a version that uses packed buckets and D1 monthly archives.

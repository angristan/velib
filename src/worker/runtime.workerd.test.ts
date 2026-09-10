import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { encodeSnapshot } from "./codec"
import {
  Aggregate,
  CompactSnapshot,
  CompactStation,
  RETENTION_SECONDS,
  ROLLUP_SECONDS,
  type SnapshotRecord,
} from "./domain"
import { makeVelibRepositoryLive, VelibRepository } from "./repository"
import { encodeRollupBucket, rollupBucketShard } from "./rollup-bucket"
import {
  DAY_SECONDS,
  makeRollupArchiveLive,
  RollupArchive,
  utcMonthStart
} from "./rollup-archive"

describe("Worker runtime bindings", () => {
  it("applies the real D1 migrations", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>()

    expect(tables.results.map(({ name }) => name)).toContain("stations")
    expect(tables.results.map(({ name }) => name)).toContain("minute_snapshots")
    expect(tables.results.map(({ name }) => name)).toContain("minute_updates")
    expect(tables.results.map(({ name }) => name)).toContain("station_observation_outbox")
    expect(tables.results.map(({ name }) => name)).toContain("station_rollup_archive_days")
    expect(tables.results.map(({ name }) => name)).toContain("station_rollup_archive_jobs")
    expect(tables.results.map(({ name }) => name)).toContain("station_rollup_archive_objects")
    expect(tables.results.map(({ name }) => name)).toContain("station_rollup_buckets_5m")
    expect(tables.results.map(({ name }) => name)).toContain("station_history_archives")
  })

  it("stores and reads one packed station rollup bucket", async () => {
    const bucketAt = 1_000_200
    const stationCode = 990_001
    const snapshot = CompactSnapshot.make({
      v: 1,
      s: [CompactStation.make({
        c: stationCode,
        m: 5,
        e: 2,
        d: 8,
        o: 1,
        r: bucketAt - 2,
      })],
    })
    const encoded = await Effect.runPromise(encodeSnapshot(snapshot))

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO stations
           (station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(stationCode, String(stationCode), "Test station", 48.85, 2.35, 15, bucketAt),
      env.DB.prepare(
        `INSERT INTO minute_snapshots
           (observed_at, source_updated_at, station_count, payload)
         VALUES (?, ?, ?, ?)`,
      ).bind(bucketAt, bucketAt - 2, 1, encoded.compressed),
    ])

    const history = await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* VelibRepository
        yield* repository.createRollups([bucketAt])
        return yield* repository.history(stationCode, "3h", bucketAt + ROLLUP_SECONDS)
      }).pipe(Effect.provide(makeVelibRepositoryLive(env.DB))),
    )

    const packed = await env.DB.prepare(
      "SELECT length(payload) AS payload_size FROM station_rollup_buckets_5m WHERE bucket_at = ?",
    ).bind(bucketAt).first<{ payload_size: number }>()
    const legacy = await env.DB.prepare(
      "SELECT 1 FROM station_rollups_5m WHERE station_code = ? AND bucket_at = ?",
    ).bind(stationCode, bucketAt).first()
    const completion = await env.DB.prepare(
      "SELECT sample_count FROM completed_rollups WHERE bucket_at = ?",
    ).bind(bucketAt).first<{ sample_count: number }>()

    expect(packed?.payload_size).toBeGreaterThan(0)
    expect(legacy).toBeNull()
    expect(history.points).toHaveLength(1)
    expect(history.points[0]).toMatchObject({
      observedAt: bucketAt,
      sampleCount: 1,
      mechanical: { avg: 5 },
      electric: { avg: 2 },
      docks: { avg: 8 },
      unavailable: { avg: 0 },
      operativeSamples: 1,
    })
    expect(completion?.sample_count).toBe(1)

    await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* VelibRepository
        yield* repository.cleanup(bucketAt + RETENTION_SECONDS + ROLLUP_SECONDS + 60)
      }).pipe(Effect.provide(makeVelibRepositoryLive(env.DB))),
    )
    const cleaned = await env.DB.prepare(
      "SELECT 1 FROM station_rollup_buckets_5m WHERE bucket_at = ?",
    ).bind(bucketAt).first()
    expect(cleaned).toBeNull()
  })

  it("packs a completed station day into a directly readable D1 archive", async () => {
    const dayAt = 30 * DAY_SECONDS
    const stationCode = 770_001
    const now = dayAt + 2 * DAY_SECONDS
    const statements: D1PreparedStatement[] = [
      env.DB.prepare(
        `INSERT OR REPLACE INTO stations
           (station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(stationCode, String(stationCode), "Archive station", 48.85, 2.35, 20, dayAt),
      env.DB.prepare(
        `INSERT INTO station_rollup_archive_days (day_at, enqueued_at)
         VALUES (?, ?)`
      ).bind(dayAt, now),
      env.DB.prepare(
        `INSERT INTO station_rollup_archive_jobs
           (day_at, station_code, next_attempt_at)
         VALUES (?, ?, ?)`
      ).bind(dayAt, stationCode, now)
    ]
    const stationRollup = (bucketAt: number, mechanicalAvg: number) => ({
      stationCode,
      bucketAt,
      sampleCount: 5,
      mechanical: Aggregate.make({ min: 3, max: 7, avg: mechanicalAvg }),
      mechanicalRemoved: 1,
      mechanicalReturned: 2,
      electric: Aggregate.make({ min: 1, max: 3, avg: 2 }),
      electricRemoved: 1,
      electricReturned: 1,
      docks: Aggregate.make({ min: 8, max: 12, avg: 10 }),
      unavailable: Aggregate.make({ min: 0, max: 2, avg: 1 }),
      operativeSamples: 5
    })
    for (let index = 0; index < 12; index += 1) {
      const bucketAt = dayAt + index * ROLLUP_SECONDS
      const payload = await Effect.runPromise(
        encodeRollupBucket(bucketAt, [stationRollup(bucketAt, 5)])
      )
      statements.push(env.DB.prepare(
        "INSERT INTO station_rollup_buckets_5m (bucket_at, shard, payload) VALUES (?, ?, ?)"
      ).bind(bucketAt, rollupBucketShard(stationCode), payload))
    }
    await env.DB.batch(statements)

    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const archive = yield* RollupArchive
        const maintenance = yield* archive.maintain(now, {
          deliveryLimit: 1,
          prepareLimit: 1
        })
        const history = yield* archive.hourlyHistory(stationCode, "30d", now)
        return { history, maintenance }
      }).pipe(Effect.provide(makeRollupArchiveLive(env.DB)))
    )

    expect(result.maintenance.prepared).toBe(1)
    expect(result.maintenance.delivered).toBe(1)
    expect(result.maintenance.backfilled).toBe(0)
    expect(result.maintenance.failed).toBe(0)
    expect(result.history).toHaveLength(1)
    expect(result.history[0]?.sampleCount).toBe(60)
    expect(result.history[0]?.mechanical.avg).toBe(5)
    const pending = await env.DB.prepare(
      "SELECT 1 FROM station_rollup_archive_jobs WHERE day_at = ? AND station_code = ?"
    ).bind(dayAt, stationCode).first()
    expect(pending).toBeNull()
    const completed = await env.DB.prepare(
      "SELECT completed_at FROM station_rollup_archive_days WHERE day_at = ?"
    ).bind(dayAt).first<{ completed_at: number | null }>()
    expect(completed?.completed_at).toBe(now)

    const replacementPayload = await Effect.runPromise(
      encodeRollupBucket(dayAt, [stationRollup(dayAt, 6)])
    )
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE station_rollup_buckets_5m SET payload = ? WHERE bucket_at = ?"
      ).bind(replacementPayload, dayAt),
      env.DB.prepare(
        "INSERT INTO station_rollup_archive_jobs (day_at, station_code, next_attempt_at) VALUES (?, ?, ?)"
      ).bind(dayAt, stationCode, now + 60)
    ])
    const replacement = await Effect.runPromise(
      Effect.gen(function*() {
        const archive = yield* RollupArchive
        yield* archive.maintain(now + 60, { deliveryLimit: 1, prepareLimit: 1 })
        return yield* archive.hourlyHistory(stationCode, "30d", now + 60)
      }).pipe(Effect.provide(makeRollupArchiveLive(env.DB)))
    )
    expect(replacement).toHaveLength(1)
    expect(replacement[0]?.sampleCount).toBe(60)
    expect(replacement[0]?.mechanical.avg).toBeCloseTo(61 / 12)

  })

  it("fails closed for corrupt D1 history", async () => {
    const stationCode = 775_001
    const now = 60 * DAY_SECONDS
    const input = new Blob([new TextEncoder().encode("not-json")]).stream()
    const compressed = await new Response(
      input.pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer()
    await env.DB.prepare(
      `INSERT INTO station_history_archives
         (station_code, month_at, complete_through, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(stationCode, utcMonthStart(now), now, compressed, now).run()

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const archive = yield* RollupArchive
        return yield* Effect.flip(archive.hourlyHistory(stationCode, "30d", now))
      }).pipe(Effect.provide(makeRollupArchiveLive(env.DB)))
    )

    expect(error._tag).toBe("RollupArchiveError")
  })

  it("atomically enqueues recent completed days once", async () => {
    const now = 50 * DAY_SECONDS + 15 * 60
    const stationCode = 660_001
    await env.DB.prepare(
      `INSERT OR REPLACE INTO stations
         (station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(stationCode, String(stationCode), "Queue station", 48.85, 2.35, 20, now).run()

    const layer = makeRollupArchiveLive(env.DB)
    await Effect.runPromise(
      Effect.gen(function*() {
        const archive = yield* RollupArchive
        yield* archive.maintain(now, { deliveryLimit: 0, prepareLimit: 0 })
        yield* archive.maintain(now, { deliveryLimit: 0, prepareLimit: 0 })
      }).pipe(Effect.provide(layer))
    )

    const jobs = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM station_rollup_archive_jobs WHERE station_code = ?"
    ).bind(stationCode).first<{ count: number }>()
    expect(jobs?.count).toBe(6)
  })

  it("replays from one baseline and persisted minute updates", async () => {
    const firstObservedAt = 2_000_040
    const stationCount = 1_500
    const repositoryProgram = Effect.gen(function*() {
      const repository = yield* VelibRepository
      for (let minute = 0; minute <= 60; minute += 1) {
        const observedAt = firstObservedAt + minute * 60
        const snapshot = CompactSnapshot.make({
          v: 1,
          s: Array.from({ length: stationCount }, (_, index) => {
            const mechanical = index < 250 ? (index + minute) % 12 : index % 12
            return CompactStation.make({
              c: 10_000 + index,
              m: mechanical,
              e: 2,
              d: 20 - mechanical,
              o: 1,
              r: observedAt - 2,
            })
          }),
        })
        const record: SnapshotRecord = {
          observedAt,
          sourceUpdatedAt: observedAt - 2,
          snapshot,
        }
        const encoded = yield* encodeSnapshot(snapshot)
        yield* repository.persistSnapshot(record, encoded)
      }

      const selected = yield* repository.snapshot(firstObservedAt + 30 * 60 - 2)
      const lastObservedAt = firstObservedAt + 60 * 60
      yield* Effect.promise(async () => {
        await env.DB.prepare(
          `DELETE FROM minute_snapshots
           WHERE observed_at > ? AND observed_at < ?`,
        ).bind(firstObservedAt, lastObservedAt).run()
      })
      const replay = yield* repository.replay(60, lastObservedAt, lastObservedAt - 2)
      return { replay, selected }
    }).pipe(Effect.provide(makeVelibRepositoryLive(env.DB)))

    const { replay, selected } = await Effect.runPromise(repositoryProgram)
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM minute_updates
       WHERE observed_at > ? AND observed_at <= ?`,
    ).bind(firstObservedAt, firstObservedAt + 60 * 60).first<{ count: number }>()

    expect(selected.sourceUpdatedAt).toBe(firstObservedAt + 30 * 60 - 2)
    expect(selected.stations).toHaveLength(stationCount)
    expect(count?.count).toBe(60)
    expect(replay.frames).toHaveLength(60)
    expect(replay.baseline.stations).toHaveLength(stationCount)
    expect(replay.frames[0]?.changes).toHaveLength(250)
    expect(replay.baseline.sourceUpdatedAt).toBe(firstObservedAt - 2)
    expect(replay.frames.at(-1)?.sourceUpdatedAt).toBe(firstObservedAt + 60 * 60 - 2)
  })

  it("runs the LiveFeed Durable Object in Workerd", async () => {
    const response = await env.LIVE_FEED.getByName("integration").fetch(
      new Request("http://localhost/live"),
    )

    expect(response.status).toBe(426)
    expect(await response.text()).toBe("WebSocket upgrade required")
  })
})

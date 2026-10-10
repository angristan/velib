import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vitest"

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
    expect(tables.results.map(({ name }) => name)).not.toContain("station_observation_outbox")
    expect(tables.results.map(({ name }) => name)).toContain("station_rollup_archive_days")
    expect(tables.results.map(({ name }) => name)).toContain("station_rollup_archive_jobs")
    expect(tables.results.map(({ name }) => name)).not.toContain("station_rollup_archive_objects")
    expect(tables.results.map(({ name }) => name)).not.toContain("station_rollups_5m")
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
    const completion = await env.DB.prepare(
      "SELECT sample_count FROM completed_rollups WHERE bucket_at = ?",
    ).bind(bucketAt).first<{ sample_count: number }>()

    expect(packed?.payload_size).toBeGreaterThan(0)
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

  it("prepares same-shard stations within one source-read budget", async () => {
    const dayAt = 80 * DAY_SECONDS
    const now = dayAt + DAY_SECONDS
    const stationCodes = [880_001, 880_017, 880_002]
    const rollup = (stationCode: number, bucketAt: number, average: number) => ({
      stationCode,
      bucketAt,
      sampleCount: 5,
      mechanical: Aggregate.make({ min: average, max: average, avg: average }),
      mechanicalRemoved: 1,
      mechanicalReturned: 2,
      electric: Aggregate.make({ min: 1, max: 3, avg: 2 }),
      electricRemoved: 1,
      electricReturned: 1,
      docks: Aggregate.make({ min: 8, max: 12, avg: 10 }),
      unavailable: Aggregate.make({ min: 0, max: 2, avg: 1 }),
      operativeSamples: 5
    })
    await env.DB.batch(stationCodes.map((code) => env.DB.prepare(
      `INSERT INTO station_rollup_archive_jobs
         (day_at, station_code, next_attempt_at) VALUES (?, ?, ?)`
    ).bind(dayAt, code, now)))
    for (let index = 0; index < 2; index += 1) {
      const bucketAt = dayAt + index * ROLLUP_SECONDS
      for (const { shard, codes } of [
        { shard: rollupBucketShard(880_001), codes: [880_001, 880_017] },
        { shard: rollupBucketShard(880_002), codes: [880_002] }
      ]) {
        const payload = await Effect.runPromise(encodeRollupBucket(
          bucketAt,
          codes.map((code) => rollup(code, bucketAt, code === 880_017 ? 7 + index * 2 : 3 + index * 2))
        ))
        await env.DB.prepare(
          "INSERT INTO station_rollup_buckets_5m (bucket_at, shard, payload) VALUES (?, ?, ?)"
        ).bind(bucketAt, shard, payload).run()
      }
    }

    const prepare = vi.spyOn(env.DB, "prepare")
    try {
      const maintenance = await Effect.runPromise(
        Effect.gen(function*() {
          const archive = yield* RollupArchive
          return yield* archive.maintain(now, { prepareLimit: 2, deliveryLimit: 0 })
        }).pipe(Effect.provide(makeRollupArchiveLive(env.DB)))
      )
      const sourceReads = prepare.mock.calls.filter(([sql]) =>
        sql.includes("FROM station_rollup_buckets_5m")
      ).length
      expect(maintenance).toMatchObject({ prepared: 2, failed: 0 })
      expect(sourceReads).toBe(1)
    } finally {
      prepare.mockRestore()
    }

    const jobs = await env.DB.prepare(
      "SELECT station_code, payload FROM station_rollup_archive_jobs WHERE day_at = ? ORDER BY station_code"
    ).bind(dayAt).all<{ station_code: number; payload: string | null }>()
    expect(jobs.results.map(({ station_code, payload }) => [station_code, payload !== null]))
      .toEqual([[880_001, true], [880_002, false], [880_017, true]])
    for (const job of jobs.results) {
      if (job.payload === null) continue
      const block = JSON.parse(job.payload)
      expect(block.stationCode).toBe(job.station_code)
      expect(block.hourly).toHaveLength(1)
      expect(block.hourly[0][1]).toBe(10)
      expect(block.hourly[0][4]).toBe(job.station_code === 880_017 ? 8 : 4)
    }
    await env.DB.prepare(
      "DELETE FROM station_rollup_archive_jobs WHERE day_at = ?"
    ).bind(dayAt).run()
  })

  it("isolates archive sources by day and shard and retries corrupt groups", async () => {
    const dayAt = 90 * DAY_SECONDS
    const now = dayAt + 2 * DAY_SECONDS
    const jobs = [
      { dayAt, code: 890_001 },
      { dayAt, code: 890_017 },
      { dayAt, code: 890_002 },
      { dayAt: dayAt + DAY_SECONDS, code: 890_001 }
    ]
    const payloadFor = (bucketAt: number, stationCode: number, average: number) =>
      Effect.runPromise(encodeRollupBucket(bucketAt, [{
        stationCode,
        bucketAt,
        sampleCount: 5,
        mechanical: Aggregate.make({ min: average, max: average, avg: average }),
        mechanicalRemoved: 1,
        mechanicalReturned: 2,
        electric: Aggregate.make({ min: 1, max: 3, avg: 2 }),
        electricRemoved: 1,
        electricReturned: 1,
        docks: Aggregate.make({ min: 8, max: 12, avg: 10 }),
        unavailable: Aggregate.make({ min: 0, max: 2, avg: 1 }),
        operativeSamples: 5
      }]))
    const sources = [
      { dayAt, code: 890_001, payload: await payloadFor(dayAt + ROLLUP_SECONDS, 890_001, 4) },
      { dayAt, code: 890_002, payload: await payloadFor(dayAt, 890_002, 6) },
      { dayAt: dayAt + DAY_SECONDS, code: 890_001, payload: await payloadFor(dayAt + DAY_SECONDS, 890_001, 9) }
    ]
    await env.DB.batch([
      ...jobs.map((job) => env.DB.prepare(
        `INSERT INTO station_rollup_archive_jobs
           (day_at, station_code, next_attempt_at) VALUES (?, ?, ?)`
      ).bind(job.dayAt, job.code, now)),
      ...sources.map((source) => env.DB.prepare(
        "INSERT INTO station_rollup_buckets_5m (bucket_at, shard, payload) VALUES (?, ?, ?)"
      ).bind(source.dayAt, rollupBucketShard(source.code), source.payload))
    ])
    const layer = makeRollupArchiveLive(env.DB)
    const maintain = (at: number) => Effect.runPromise(
      Effect.gen(function*() {
        const archive = yield* RollupArchive
        return yield* archive.maintain(at, { prepareLimit: 4, deliveryLimit: 0 })
      }).pipe(Effect.provide(layer))
    )
    expect(await maintain(now)).toMatchObject({ prepared: 2, failed: 2 })
    const rows = await env.DB.prepare(
      `SELECT day_at, station_code, payload, next_attempt_at, last_attempt_at
       FROM station_rollup_archive_jobs WHERE day_at IN (?, ?) ORDER BY day_at, station_code`
    ).bind(dayAt, dayAt + DAY_SECONDS).all<{
      day_at: number
      station_code: number
      payload: string | null
      next_attempt_at: number
      last_attempt_at: number | null
    }>()
    for (const row of rows.results) {
      if (row.day_at === dayAt && row.station_code !== 890_002) {
        expect(row.payload).toBeNull()
        expect(row.next_attempt_at).toBe(now + 60)
        expect(row.last_attempt_at).toBeNull()
      } else {
        expect(row.payload).not.toBeNull()
        const block = JSON.parse(row.payload ?? "null")
        expect(block.dayAt).toBe(row.day_at)
        expect(block.hourly[0][4]).toBe(row.station_code === 890_002 ? 6 : 9)
      }
    }
    const repaired = await payloadFor(dayAt, 890_001, 4)
    await env.DB.prepare(
      "UPDATE station_rollup_buckets_5m SET payload = ? WHERE bucket_at = ? AND shard = ?"
    ).bind(repaired, dayAt, rollupBucketShard(890_001)).run()
    expect(await maintain(now + 60)).toMatchObject({ prepared: 2, failed: 0 })
    const recovered = await env.DB.prepare(
      "SELECT payload FROM station_rollup_archive_jobs WHERE day_at = ? AND station_code = ?"
    ).bind(dayAt, 890_001).first<{ payload: string }>()
    expect(JSON.parse(recovered?.payload ?? "null").hourly[0][4]).toBe(4)
    await env.DB.prepare(
      "DELETE FROM station_rollup_archive_jobs WHERE day_at IN (?, ?)"
    ).bind(dayAt, dayAt + DAY_SECONDS).run()
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

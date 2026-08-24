import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { ArchiveOutboxStore, makeArchiveOutboxStoreLive } from "./archive-outbox"
import { encodeSnapshot } from "./codec"
import {
  CompactSnapshot,
  CompactStation,
  RETENTION_SECONDS,
  ROLLUP_SECONDS,
  type SnapshotRecord,
} from "./domain"
import { makeVelibRepositoryLive, VelibRepository } from "./repository"
import {
  DAY_SECONDS,
  makeRollupArchiveLive,
  RollupArchive,
  rollupObjectKey,
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
  })

  it("bulk upserts station rollups through real D1 JSON functions", async () => {
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

    await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* VelibRepository
        yield* repository.createRollups([bucketAt])
      }).pipe(Effect.provide(makeVelibRepositoryLive(env.DB))),
    )

    const rollup = await env.DB.prepare(
      `SELECT sample_count, mechanical_avg, electric_avg, docks_avg, unavailable_avg,
              operative_samples
       FROM station_rollups_5m
       WHERE station_code = ? AND bucket_at = ?`,
    ).bind(stationCode, bucketAt).first<Record<string, number>>()
    const completion = await env.DB.prepare(
      "SELECT sample_count FROM completed_rollups WHERE bucket_at = ?",
    ).bind(bucketAt).first<{ sample_count: number }>()

    expect(rollup).toEqual({
      sample_count: 1,
      mechanical_avg: 5,
      electric_avg: 2,
      docks_avg: 8,
      unavailable_avg: 0,
      operative_samples: 1,
    })
    expect(completion?.sample_count).toBe(1)

    await Effect.runPromise(
      Effect.gen(function*() {
        const repository = yield* VelibRepository
        yield* repository.cleanup(bucketAt + RETENTION_SECONDS + ROLLUP_SECONDS + 60)
      }).pipe(Effect.provide(makeVelibRepositoryLive(env.DB))),
    )
    const cleaned = await env.DB.prepare(
      "SELECT 1 FROM station_rollups_5m WHERE station_code = ? AND bucket_at = ?",
    ).bind(stationCode, bucketAt).first()
    expect(cleaned).toBeNull()
  })

  it("claims and completes a durable archive from real D1", async () => {
    const observedAt = 1_500_000
    const snapshot = CompactSnapshot.make({
      v: 1,
      s: [CompactStation.make({
        c: 880_001,
        m: 4,
        e: 3,
        d: 9,
        o: 1,
        r: observedAt - 2,
      })],
    })
    const encoded = await Effect.runPromise(encodeSnapshot(snapshot))
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO minute_snapshots
           (observed_at, source_updated_at, station_count, payload)
         VALUES (?, ?, ?, ?)`,
      ).bind(observedAt, observedAt - 2, 1, encoded.compressed),
      env.DB.prepare(
        `INSERT INTO station_observation_outbox
           (observed_at, source_updated_at, capacities, next_attempt_at)
         VALUES (?, ?, ?, ?)`,
      ).bind(observedAt, observedAt - 2, JSON.stringify([[880_001, 20]]), observedAt),
    ])

    const claims = await Effect.runPromise(
      Effect.gen(function*() {
        const outbox = yield* ArchiveOutboxStore
        return yield* outbox.claim(observedAt + 60, 3, observedAt + 240)
      }).pipe(Effect.provide(makeArchiveOutboxStoreLive(env.DB))),
    )

    expect(claims).toHaveLength(1)
    expect(claims[0]?.attempts).toBe(1)
    expect(claims[0]?.capacities.get(880_001)).toBe(20)
    expect(claims[0]?.stations).toEqual(snapshot.s)

    await Effect.runPromise(
      Effect.gen(function*() {
        const outbox = yield* ArchiveOutboxStore
        yield* outbox.complete(observedAt)
      }).pipe(Effect.provide(makeArchiveOutboxStoreLive(env.DB))),
    )
    const pending = await env.DB.prepare(
      "SELECT 1 FROM station_observation_outbox WHERE observed_at = ?",
    ).bind(observedAt).first()
    expect(pending).toBeNull()
  })

  it("packs a completed station day into a directly readable R2 object", async () => {
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
    for (let index = 0; index < 12; index += 1) {
      statements.push(env.DB.prepare(
        `INSERT INTO station_rollups_5m (
           station_code, bucket_at, sample_count,
           mechanical_min, mechanical_max, mechanical_avg, mechanical_removed, mechanical_returned,
           electric_min, electric_max, electric_avg, electric_removed, electric_returned,
           docks_min, docks_max, docks_avg,
           unavailable_min, unavailable_max, unavailable_avg, operative_samples
         ) VALUES (?, ?, 5, 3, 7, 5, 1, 2, 1, 3, 2, 1, 1, 8, 12, 10, 0, 2, 1, 5)`
      ).bind(stationCode, dayAt + index * ROLLUP_SECONDS))
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
      }).pipe(Effect.provide(makeRollupArchiveLive(env.DB, env.HISTORY_ROLLUPS)))
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

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE station_rollups_5m SET mechanical_avg = 6 WHERE station_code = ? AND bucket_at = ?"
      ).bind(stationCode, dayAt),
      env.DB.prepare(
        "INSERT INTO station_rollup_archive_jobs (day_at, station_code, next_attempt_at) VALUES (?, ?, ?)"
      ).bind(dayAt, stationCode, now + 60)
    ])
    const replacement = await Effect.runPromise(
      Effect.gen(function*() {
        const archive = yield* RollupArchive
        yield* archive.maintain(now + 60, { deliveryLimit: 1, prepareLimit: 1 })
        return yield* archive.hourlyHistory(stationCode, "30d", now + 60)
      }).pipe(Effect.provide(makeRollupArchiveLive(env.DB, env.HISTORY_ROLLUPS)))
    )
    expect(replacement).toHaveLength(1)
    expect(replacement[0]?.sampleCount).toBe(60)
    expect(replacement[0]?.mechanical.avg).toBeCloseTo(61 / 12)

    await env.HISTORY_ROLLUPS.delete(rollupObjectKey(stationCode, utcMonthStart(dayAt)))
  })

  it("fails closed for a corrupt long-history object", async () => {
    const stationCode = 775_001
    const now = 60 * DAY_SECONDS
    const key = rollupObjectKey(stationCode, utcMonthStart(now))
    const input = new Blob([new TextEncoder().encode("not-json")]).stream()
    const compressed = await new Response(
      input.pipeThrough(new CompressionStream("gzip"))
    ).arrayBuffer()
    const object = await env.HISTORY_ROLLUPS.put(key, compressed)
    expect(object).not.toBeNull()
    if (object === null) throw new Error("Could not create corrupt R2 test fixture")
    await env.DB.prepare(
      `INSERT INTO station_rollup_archive_objects
         (station_code, month_at, complete_through, etag, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(stationCode, utcMonthStart(now), now, object.etag, now).run()

    const error = await Effect.runPromise(
      Effect.gen(function*() {
        const archive = yield* RollupArchive
        return yield* Effect.flip(archive.hourlyHistory(stationCode, "30d", now))
      }).pipe(Effect.provide(makeRollupArchiveLive(env.DB, env.HISTORY_ROLLUPS)))
    )

    expect(error._tag).toBe("RollupArchiveError")
    await env.HISTORY_ROLLUPS.delete(key)
    await env.DB.prepare(
      "DELETE FROM station_rollup_archive_objects WHERE station_code = ? AND month_at = ?"
    ).bind(stationCode, utcMonthStart(now)).run()
  })

  it("atomically enqueues recent completed days once", async () => {
    const now = 50 * DAY_SECONDS + 15 * 60
    const stationCode = 660_001
    await env.DB.prepare(
      `INSERT OR REPLACE INTO stations
         (station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(stationCode, String(stationCode), "Queue station", 48.85, 2.35, 20, now).run()

    const layer = makeRollupArchiveLive(env.DB, env.HISTORY_ROLLUPS)
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

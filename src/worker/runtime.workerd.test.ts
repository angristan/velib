import { env } from "cloudflare:workers"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { encodeSnapshot } from "./codec"
import {
  CompactSnapshot,
  CompactStation,
  RETENTION_SECONDS,
  ROLLUP_SECONDS,
  type SnapshotRecord,
} from "./domain"
import { makeVelibRepositoryLive, VelibRepository } from "./repository"

describe("Worker runtime bindings", () => {
  it("applies the real D1 migrations", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>()

    expect(tables.results.map(({ name }) => name)).toContain("stations")
    expect(tables.results.map(({ name }) => name)).toContain("minute_snapshots")
    expect(tables.results.map(({ name }) => name)).toContain("minute_updates")
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
        yield* repository.cleanup(bucketAt + RETENTION_SECONDS + ROLLUP_SECONDS)
      }).pipe(Effect.provide(makeVelibRepositoryLive(env.DB))),
    )
    const cleaned = await env.DB.prepare(
      "SELECT 1 FROM station_rollups_5m WHERE station_code = ? AND bucket_at = ?",
    ).bind(stationCode, bucketAt).first()
    expect(cleaned).toBeNull()
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

      const lastObservedAt = firstObservedAt + 60 * 60
      yield* Effect.promise(async () => {
        await env.DB.prepare(
          `DELETE FROM minute_snapshots
           WHERE observed_at > ? AND observed_at < ?`,
        ).bind(firstObservedAt, lastObservedAt).run()
      })
      return yield* repository.replay(60, lastObservedAt, lastObservedAt - 2)
    }).pipe(Effect.provide(makeVelibRepositoryLive(env.DB)))

    const replay = await Effect.runPromise(repositoryProgram)
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM minute_updates
       WHERE observed_at > ? AND observed_at <= ?`,
    ).bind(firstObservedAt, firstObservedAt + 60 * 60).first<{ count: number }>()

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

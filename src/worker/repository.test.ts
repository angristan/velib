import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { encodeSnapshot } from "./codec"
import {
  CompactSnapshot,
  CompactStation,
  RETENTION_SECONDS,
  ROLLUP_SECONDS,
  type SnapshotRecord
} from "./domain"
import { makeVelibRepositoryLive, VelibRepository } from "./repository"

interface FakeStatement extends D1PreparedStatement {
  readonly sql: string
  readonly values: readonly unknown[]
}

interface FakeDatabaseHandlers {
  readonly first?: (sql: string, values: readonly unknown[]) => unknown | null
  readonly all?: (sql: string, values: readonly unknown[]) => readonly unknown[]
  readonly run?: (sql: string, values: readonly unknown[]) => void
  readonly batch?: (
    statements: readonly FakeStatement[]
  ) => ReadonlyArray<ReadonlyArray<unknown>> | void
}

const fakeResult = <T>(results: readonly T[] = []): D1Result<T> =>
  ({ results: [...results], success: true }) as D1Result<T>

const makeFakeDatabase = (handlers: FakeDatabaseHandlers): D1Database => {
  const makeStatement = (sql: string, values: readonly unknown[] = []): FakeStatement => ({
    sql,
    values,
    bind: (...nextValues: unknown[]) => makeStatement(sql, nextValues),
    first: async <T>() => (handlers.first?.(sql, values) ?? null) as T | null,
    all: async <T>() => fakeResult((handlers.all?.(sql, values) ?? []) as readonly T[]),
    raw: async <T>() => (handlers.all?.(sql, values) ?? []) as T[],
    run: async <T>() => {
      handlers.run?.(sql, values)
      return fakeResult<T>()
    },
  } as unknown as FakeStatement)

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: async <T>(statements: D1PreparedStatement[]) => {
      const handled = handlers.batch?.(statements as unknown as readonly FakeStatement[])
      const rowsByStatement = handled === undefined ? [] : handled
      return statements.map((_, index) =>
        fakeResult((rowsByStatement[index] ?? []) as readonly T[])
      )
    },
  } as unknown as D1Database
}

const snapshotRecord = (observedAt: number, mechanical: number): SnapshotRecord => ({
  observedAt,
  sourceUpdatedAt: observedAt - 2,
  snapshot: CompactSnapshot.make({
    v: 1,
    s: [CompactStation.make({
      c: 2009,
      m: mechanical,
      e: 2,
      d: 8,
      o: 1,
      r: observedAt - 2,
    })],
  }),
})

it.effect("validates the authoritative latest header before reusing the warm snapshot", () => {
  const initial = snapshotRecord(60, 5)
  let latest = {
    observedAt: initial.observedAt,
    sourceUpdatedAt: initial.sourceUpdatedAt,
    payload: JSON.stringify(initial.snapshot),
  }
  let fullPayloadReads = 0
  const persistedPayloads: string[] = []
  const persistedUpdates: string[] = []

  const db = makeFakeDatabase({
    first: (sql) => {
      if (sql.includes("source_updated_at, payload")) {
        fullPayloadReads += 1
        return {
          observed_at: latest.observedAt,
          source_updated_at: latest.sourceUpdatedAt,
          payload: latest.payload,
        }
      }
      if (sql.includes("FROM latest_status")) {
        return {
          observed_at: latest.observedAt,
          source_updated_at: latest.sourceUpdatedAt,
        }
      }
      return null
    },
    batch: (statements) => {
      const latestStatement = statements.find((candidate) =>
        candidate.sql.includes("INSERT INTO latest_status")
      )
      if (latestStatement !== undefined) {
        const [observedAt, sourceUpdatedAt, payload] = latestStatement.values
        latest = {
          observedAt: observedAt as number,
          sourceUpdatedAt: sourceUpdatedAt as number,
          payload: payload as string,
        }
        persistedPayloads.push(payload as string)
      }
      const updateStatement = statements.find((candidate) =>
        candidate.sql.includes("INSERT OR IGNORE INTO minute_updates")
      )
      if (updateStatement !== undefined) {
        persistedUpdates.push(updateStatement.values[3] as string)
      }
    },
  })

  return Effect.gen(function*() {
    const first = snapshotRecord(120, 6)
    const second = snapshotRecord(180, 7)
    const firstEncoded = yield* encodeSnapshot(first.snapshot)
    const secondEncoded = yield* encodeSnapshot(second.snapshot)
    const repository = yield* VelibRepository

    const firstResult = yield* repository.persistSnapshot(first, firstEncoded)
    const secondResult = yield* repository.persistSnapshot(second, secondEncoded)
    const latestTimestamp = yield* repository.latestSourceUpdatedAt()

    assert.deepEqual(firstResult.previous, initial)
    assert.deepEqual(secondResult.previous, first)
    assert.strictEqual(firstResult.liveUpdate?.previousSourceUpdatedAt, initial.sourceUpdatedAt)
    assert.strictEqual(secondResult.liveUpdate?.previousSourceUpdatedAt, first.sourceUpdatedAt)
    assert.strictEqual(latestTimestamp, second.sourceUpdatedAt)
    assert.strictEqual(fullPayloadReads, 1)
    assert.deepEqual(persistedPayloads, [firstEncoded.text, secondEncoded.text])
    assert.strictEqual(persistedUpdates.length, 2)
    assert.strictEqual(JSON.parse(persistedUpdates[1] ?? "null").sourceUpdatedAt, 178)
  }).pipe(Effect.provide(makeVelibRepositoryLive(db)))
})

it.effect("discovers all rollup repairs with one D1 query", () => {
  const bucketAts = [3_000, 2_700, 2_400]
  let discoveryQueries = 0
  const completedEmptyBuckets: number[] = []
  const db = makeFakeDatabase({
    all: (sql) => {
      if (sql.includes("WITH requested(bucket_at)")) {
        discoveryQueries += 1
        return [
          { bucket_at: 3_000, snapshot_count: 5, completed_sample_count: 5 },
          { bucket_at: 2_700, snapshot_count: 0, completed_sample_count: null },
          { bucket_at: 2_400, snapshot_count: 4, completed_sample_count: 4 },
        ]
      }
      throw new Error(`Unexpected query: ${sql}`)
    },
    batch: (statements) => {
      if (statements[0]?.sql.includes("FROM minute_snapshots")) return [[], []]
    },
    run: (sql, values) => {
      if (sql.includes("INSERT INTO completed_rollups")) {
        completedEmptyBuckets.push(values[0] as number)
      }
    },
  })

  return Effect.gen(function*() {
    const repository = yield* VelibRepository
    yield* repository.createRollups(bucketAts)

    assert.strictEqual(discoveryQueries, 1)
    assert.deepEqual(completedEmptyBuckets, [2_700])
  }).pipe(Effect.provide(makeVelibRepositoryLive(db)))
})

it.effect("writes a station rollup with one JSON-backed D1 batch", () =>
  Effect.gen(function*() {
    const bucketAt = 3_000
    const record = snapshotRecord(bucketAt, 5)
    const encoded = yield* encodeSnapshot(record.snapshot)
    let inputBatches = 0
    const writeBatches: Array<ReadonlyArray<FakeStatement>> = []
    const db = makeFakeDatabase({
      all: (sql) => {
        if (sql.includes("WITH requested(bucket_at)")) {
          return [{ bucket_at: bucketAt, snapshot_count: 1, completed_sample_count: null }]
        }
        throw new Error(`Unexpected query: ${sql}`)
      },
      batch: (statements) => {
        if (statements[0]?.sql.includes("FROM minute_snapshots")) {
          inputBatches += 1
          return [
            [{
              observed_at: record.observedAt,
              source_updated_at: record.sourceUpdatedAt,
              payload: encoded.compressed
            }],
            [{
              station_code: 2009,
              station_id: "2009",
              name: "Test station",
              latitude: 48.85,
              longitude: 2.35,
              capacity: 15,
              metadata_updated_at: bucketAt
            }]
          ]
        }
        writeBatches.push(statements)
      }
    })

    yield* Effect.gen(function*() {
      const repository = yield* VelibRepository
      yield* repository.createRollups([bucketAt])
    }).pipe(Effect.provide(makeVelibRepositoryLive(db)))

    assert.strictEqual(inputBatches, 1)
    assert.strictEqual(writeBatches.length, 1)
    assert.strictEqual(writeBatches[0]?.length, 3)
    const stationWrite = writeBatches[0]?.[0]
    assert.isDefined(stationWrite)
    assert.include(stationWrite.sql, "json_each(?)")
    assert.notInclude(stationWrite.sql, "VALUES (?,")
    assert.deepEqual(JSON.parse(stationWrite.values[0] as string), [[
      2009, bucketAt, 1,
      5, 5, 5, 0, 0,
      2, 2, 2, 0, 0,
      8, 8, 8,
      0, 0, 0, 1
    ]])
  })
)

it.effect("runs cleanup without station lookup round trips", () => {
  const observedAt = RETENTION_SECONDS + ROLLUP_SECONDS * 2
  const batches: Array<ReadonlyArray<FakeStatement>> = []
  const db = makeFakeDatabase({
    all: (sql) => {
      throw new Error(`Unexpected cleanup query: ${sql}`)
    },
    batch: (statements) => {
      batches.push(statements)
    }
  })

  return Effect.gen(function*() {
    const repository = yield* VelibRepository
    yield* repository.cleanup(observedAt)

    assert.strictEqual(batches.length, 1)
    assert.strictEqual(batches[0]?.length, 7)
    assert.include(batches[0]?.[1]?.sql ?? "", "DELETE FROM minute_updates")
    const rotatingCleanup = batches[0]?.[5]
    const bucketCleanup = batches[0]?.[6]
    assert.isDefined(rotatingCleanup)
    assert.isDefined(bucketCleanup)
    assert.include(rotatingCleanup.sql, "station_code IN")
    assert.include(rotatingCleanup.sql, "station_code % 300 = ?")
    assert.deepEqual(rotatingCleanup.values, [
      Math.floor(observedAt / 60) % 300,
      observedAt - RETENTION_SECONDS
    ])
    assert.include(bucketCleanup.sql, "station_code IN (SELECT station_code FROM stations)")
    assert.deepEqual(bucketCleanup.values, [
      observedAt - ROLLUP_SECONDS - RETENTION_SECONDS
    ])
  }).pipe(Effect.provide(makeVelibRepositoryLive(db)))
})

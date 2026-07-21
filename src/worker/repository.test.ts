import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { encodeSnapshot } from "./codec"
import { CompactSnapshot, CompactStation, type SnapshotRecord } from "./domain"
import { makeVelibRepositoryLive, VelibRepository } from "./repository"

interface FakeStatement extends D1PreparedStatement {
  readonly sql: string
  readonly values: readonly unknown[]
}

interface FakeDatabaseHandlers {
  readonly first?: (sql: string, values: readonly unknown[]) => unknown | null
  readonly all?: (sql: string, values: readonly unknown[]) => readonly unknown[]
  readonly run?: (sql: string, values: readonly unknown[]) => void
  readonly batch?: (statements: readonly FakeStatement[]) => void
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
      handlers.batch?.(statements as unknown as readonly FakeStatement[])
      return statements.map(() => fakeResult<T>())
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
      const statement = statements.find((candidate) =>
        candidate.sql.includes("INSERT INTO latest_status")
      )
      if (statement === undefined) return
      const [observedAt, sourceUpdatedAt, payload] = statement.values
      latest = {
        observedAt: observedAt as number,
        sourceUpdatedAt: sourceUpdatedAt as number,
        payload: payload as string,
      }
      persistedPayloads.push(payload as string)
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

    assert.deepEqual(firstResult.previous, initial)
    assert.deepEqual(secondResult.previous, first)
    assert.strictEqual(fullPayloadReads, 1)
    assert.deepEqual(persistedPayloads, [firstEncoded.text, secondEncoded.text])
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
      if (sql.includes("FROM minute_snapshots")) return []
      throw new Error(`Unexpected query: ${sql}`)
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

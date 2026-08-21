import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { ArchiveOutboxStore, makeArchiveOutboxStoreLive } from "./archive-outbox"
import { encodeSnapshot } from "./codec"
import { CompactSnapshot, CompactStation } from "./domain"

interface FakeStatement extends D1PreparedStatement {
  readonly sql: string
  readonly values: readonly unknown[]
}

interface FakeDatabaseHandlers {
  readonly all?: (sql: string, values: readonly unknown[]) => readonly unknown[]
  readonly run?: (sql: string, values: readonly unknown[]) => void
}

const fakeResult = <T>(results: readonly T[] = []): D1Result<T> =>
  ({ results: [...results], success: true }) as D1Result<T>

const makeFakeDatabase = (handlers: FakeDatabaseHandlers): D1Database => {
  const makeStatement = (sql: string, values: readonly unknown[] = []): FakeStatement => ({
    sql,
    values,
    bind: (...nextValues: unknown[]) => makeStatement(sql, nextValues),
    first: async () => null,
    all: async <T>() => fakeResult((handlers.all?.(sql, values) ?? []) as readonly T[]),
    raw: async <T>() => (handlers.all?.(sql, values) ?? []) as T[],
    run: async <T>() => {
      handlers.run?.(sql, values)
      return fakeResult<T>()
    }
  } as unknown as FakeStatement)

  return {
    prepare: (sql: string) => makeStatement(sql),
    batch: async () => []
  } as unknown as D1Database
}

it.effect("claims retained snapshots with immutable capacities and a lease", () =>
  Effect.gen(function*() {
    const observedAt = 3_000
    const sourceUpdatedAt = 2_998
    const snapshot = CompactSnapshot.make({
      v: 1,
      s: [CompactStation.make({
        c: 2009,
        m: 5,
        e: 2,
        d: 8,
        o: 1,
        r: sourceUpdatedAt
      })]
    })
    const encoded = yield* encodeSnapshot(snapshot)
    const transitions: Array<{ readonly sql: string; readonly values: readonly unknown[] }> = []
    const db = makeFakeDatabase({
      all: (sql, values) => {
        if (sql.includes("UPDATE station_observation_outbox")) {
          assert.deepEqual(values, [3_060, 3_240, 3_060, 3])
          return [{
            observed_at: observedAt,
            source_updated_at: sourceUpdatedAt,
            capacities: JSON.stringify([[2009, 20]]),
            attempts: 2
          }]
        }
        if (sql.includes("FROM minute_snapshots")) {
          return [{
            observed_at: observedAt,
            source_updated_at: sourceUpdatedAt,
            payload: encoded.compressed
          }]
        }
        throw new Error(`Unexpected query: ${sql}`)
      },
      run: (sql, values) => {
        transitions.push({ sql, values })
      }
    })

    const claims = yield* Effect.gen(function*() {
      const outbox = yield* ArchiveOutboxStore
      const claimed = yield* outbox.claim(3_060, 3, 3_240)
      yield* outbox.complete(3_000)
      yield* outbox.retry(3_060, 3_120)
      yield* outbox.release([3_120, 3_180], 3_120)
      return claimed
    }).pipe(Effect.provide(makeArchiveOutboxStoreLive(db)))

    assert.strictEqual(claims.length, 1)
    assert.strictEqual(claims[0]?.attempts, 2)
    assert.strictEqual(claims[0]?.capacities.get(2009), 20)
    assert.deepEqual(claims[0]?.stations, snapshot.s)
    assert.strictEqual(transitions.length, 3)
    assert.deepEqual(transitions.map(({ values }) => values), [
      [3_000],
      [3_120, 3_060],
      [3_120, 3_120, 3_180]
    ])
  })
)

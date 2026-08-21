import { Context, Effect, Layer, Schema } from "effect"

import type { ClaimedArchive } from "./archive"
import { decompressSnapshot } from "./codec"
import { RepositoryError } from "./domain"

const ArchiveClaimRow = Schema.Struct({
  observed_at: Schema.Number,
  source_updated_at: Schema.Number,
  capacities: Schema.String,
  attempts: Schema.Number
})
const CapacityEntries = Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))
const SnapshotPayload = Schema.Union([
  Schema.Array(Schema.Number),
  Schema.Uint8Array,
  Schema.instanceOf(ArrayBuffer)
])
const SnapshotRow = Schema.Struct({
  observed_at: Schema.Number,
  source_updated_at: Schema.Number,
  payload: SnapshotPayload
})

export class ArchiveOutboxStore extends Context.Service<ArchiveOutboxStore, {
  readonly claim: (
    now: number,
    limit: number,
    leaseUntil: number
  ) => Effect.Effect<ReadonlyArray<ClaimedArchive>, RepositoryError>
  readonly complete: (observedAt: number) => Effect.Effect<void, RepositoryError>
  readonly retry: (
    observedAt: number,
    nextAttemptAt: number
  ) => Effect.Effect<void, RepositoryError>
  readonly release: (
    observedAts: ReadonlyArray<number>,
    nextAttemptAt: number
  ) => Effect.Effect<void, RepositoryError>
}>()("velib/ArchiveOutboxStore") {}

const repositoryError = (operation: string, cause: unknown): RepositoryError =>
  RepositoryError.make({
    operation,
    detail: `D1 operation failed: ${operation}`,
    cause
  })

const decodeError = (operation: string, cause: unknown): RepositoryError =>
  RepositoryError.make({
    operation,
    detail: `D1 returned invalid data for ${operation}`,
    cause
  })

const allRows = Effect.fn("ArchiveOutboxStore.allRows")(function*(
  statement: D1PreparedStatement,
  operation: string
) {
  return yield* Effect.tryPromise({
    try: async () => (await statement.all<Record<string, unknown>>()).results,
    catch: (cause) => repositoryError(operation, cause)
  })
})

const runStatement = Effect.fn("ArchiveOutboxStore.runStatement")(function*(
  statement: D1PreparedStatement,
  operation: string
) {
  yield* Effect.tryPromise({
    try: async () => {
      await statement.run()
    },
    catch: (cause) => repositoryError(operation, cause)
  })
})

const decodeRows = <S extends Schema.Top>(schema: S, input: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => decodeError(operation, cause))
  )

const decodeCapacityEntries = Effect.fn("ArchiveOutboxStore.decodeCapacityEntries")(function*(
  payload: string
) {
  const input = yield* Effect.try({
    try: (): unknown => JSON.parse(payload),
    catch: (cause) => decodeError("decodeCapacityEntries.json", cause)
  })
  return yield* Schema.decodeUnknownEffect(CapacityEntries)(input).pipe(
    Effect.mapError((cause) => decodeError("decodeCapacityEntries.schema", cause))
  )
})

const makeArchiveOutboxStore = (db: D1Database): ArchiveOutboxStore["Service"] => {
  const claim = Effect.fn("ArchiveOutboxStore.claim")(function*(
    now: number,
    limit: number,
    leaseUntil: number
  ) {
    const rows = yield* allRows(
      db.prepare(
        `UPDATE station_observation_outbox
         SET attempts = attempts + 1,
             last_attempt_at = ?,
             next_attempt_at = ?
         WHERE observed_at IN (
           SELECT observed_at
           FROM station_observation_outbox
           WHERE next_attempt_at <= ?
           ORDER BY observed_at
           LIMIT ?
         )
         RETURNING observed_at, source_updated_at, capacities, attempts`
      ).bind(now, leaseUntil, now, limit),
      "claim"
    )
    const claims = yield* decodeRows(Schema.Array(ArchiveClaimRow), rows, "claim")
    if (claims.length === 0) return []

    const placeholders = claims.map(() => "?").join(", ")
    const snapshotRows = yield* allRows(
      db.prepare(
        `SELECT observed_at, source_updated_at, payload
         FROM minute_snapshots
         WHERE observed_at IN (${placeholders})
         ORDER BY observed_at`
      ).bind(...claims.map(({ observed_at }) => observed_at)),
      "claim.snapshots"
    )
    const snapshots = yield* decodeRows(
      Schema.Array(SnapshotRow),
      snapshotRows,
      "claim.snapshots"
    )
    if (snapshots.length !== claims.length) {
      return yield* Effect.fail(decodeError(
        "claim.snapshots",
        new Error("Claimed archive snapshot is missing")
      ))
    }

    const claimByObservedAt = new Map(claims.map((item) => [item.observed_at, item]))
    return yield* Effect.forEach(snapshots, (row) =>
      Effect.gen(function*() {
        const item = claimByObservedAt.get(row.observed_at)
        if (item === undefined || item.source_updated_at !== row.source_updated_at) {
          return yield* Effect.fail(decodeError(
            "claim.snapshot",
            new Error("Claimed archive does not match its snapshot")
          ))
        }
        const [snapshot, capacityEntries] = yield* Effect.all([
          decompressSnapshot(row.payload).pipe(
            Effect.mapError((cause) => decodeError("claim.payload", cause))
          ),
          decodeCapacityEntries(item.capacities)
        ])
        return {
          attempts: item.attempts,
          capacities: new Map(capacityEntries),
          observedAt: row.observed_at,
          sourceUpdatedAt: row.source_updated_at,
          stations: snapshot.s
        } satisfies ClaimedArchive
      })
    )
  })

  const complete = Effect.fn("ArchiveOutboxStore.complete")(function*(observedAt: number) {
    yield* runStatement(
      db.prepare("DELETE FROM station_observation_outbox WHERE observed_at = ?").bind(observedAt),
      "complete"
    )
  })

  const retry = Effect.fn("ArchiveOutboxStore.retry")(function*(
    observedAt: number,
    nextAttemptAt: number
  ) {
    yield* runStatement(
      db.prepare(
        `UPDATE station_observation_outbox
         SET next_attempt_at = ?
         WHERE observed_at = ?`
      ).bind(nextAttemptAt, observedAt),
      "retry"
    )
  })

  const release = Effect.fn("ArchiveOutboxStore.release")(function*(
    observedAts: ReadonlyArray<number>,
    nextAttemptAt: number
  ) {
    if (observedAts.length === 0) return
    const placeholders = observedAts.map(() => "?").join(", ")
    yield* runStatement(
      db.prepare(
        `UPDATE station_observation_outbox
         SET attempts = CASE WHEN attempts > 0 THEN attempts - 1 ELSE 0 END,
             last_attempt_at = NULL,
             next_attempt_at = ?
         WHERE observed_at IN (${placeholders})`
      ).bind(nextAttemptAt, ...observedAts),
      "release"
    )
  })

  return { claim, complete, retry, release }
}

export const makeArchiveOutboxStoreLive = (db: D1Database) =>
  Layer.succeed(ArchiveOutboxStore, makeArchiveOutboxStore(db))

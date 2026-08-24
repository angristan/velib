import { Effect } from "effect"

import { encodeSnapshot } from "./codec"
import {
  AppError,
  CollectionRecord,
  CompactSnapshot,
  type PersistSnapshotResult,
  ROLLUP_SECONDS,
  SnapshotRecord
} from "./domain"
import { GbfsClient } from "./gbfs"
import { VelibRepository } from "./repository"

export interface CollectionResult {
  readonly liveUpdate: PersistSnapshotResult["liveUpdate"]
}

const errorDetail = (error: AppError): string => {
  switch (error._tag) {
    case "FeedError":
    case "RepositoryError":
    case "CodecError":
    case "RequestError":
      return error.detail
    case "NotFoundError":
      return `Not found: ${error.resource}`
  }
}

export const collectMinute = Effect.fn("collectMinute")(function*(observedAt: number) {
  const client = yield* GbfsClient
  const repository = yield* VelibRepository
  const startedAt = Date.now()

  const collection = Effect.gen(function*() {
    let phaseStartedAt = Date.now()
    const status = yield* client.fetchStatus()
    const fetchStatusMs = Date.now() - phaseStartedAt

    phaseStartedAt = Date.now()
    if (yield* repository.needsMetadata(observedAt)) {
      const metadata = yield* client.fetchInformation().pipe(
        Effect.catch((error) =>
          repository.hasMetadata().pipe(
            Effect.flatMap((available) => available
              ? Effect.logWarning("Station metadata refresh skipped", {
                errorTag: error._tag,
                detail: error.detail
              }).pipe(Effect.as(null))
              : Effect.fail(error)
            )
          )
        )
      )
      if (metadata !== null) {
        yield* repository.syncMetadata(metadata.stations, observedAt)
        yield* Effect.logInfo("Station metadata synchronized", {
          stations: metadata.stations.length,
          sourceUpdatedAt: metadata.sourceUpdatedAt
        })
      }
    }
    const metadataMs = Date.now() - phaseStartedAt

    phaseStartedAt = Date.now()
    const snapshot = CompactSnapshot.make({ v: 1, s: status.stations })
    const record: SnapshotRecord = {
      observedAt,
      sourceUpdatedAt: status.sourceUpdatedAt,
      snapshot
    }
    const encoded = yield* encodeSnapshot(snapshot)
    const capacities = yield* repository.capacities().pipe(
      Effect.catch((error) =>
        Effect.logWarning("Station capacities unavailable for archive", {
          operation: error.operation,
          detail: error.detail
        }).pipe(Effect.as(new Map<number, number>()))
      )
    )
    const prepareSnapshotMs = Date.now() - phaseStartedAt

    phaseStartedAt = Date.now()
    const persisted = yield* repository.persistSnapshot(record, encoded, capacities)
    const persistSnapshotMs = Date.now() - phaseStartedAt
    const collectionStatus = persisted.status
    const liveUpdate = persisted.liveUpdate

    phaseStartedAt = Date.now()
    if (observedAt % ROLLUP_SECONDS === 0) {
      // Finalize one bucket late so a delayed prior Cron can persist its last minute.
      const recentBuckets = Array.from(
        { length: 12 },
        (_, index) => observedAt - (index + 2) * ROLLUP_SECONDS
      )
      yield* repository.createRollups(recentBuckets)
    }
    const createRollupsMs = Date.now() - phaseStartedAt

    phaseStartedAt = Date.now()
    yield* repository.cleanup(observedAt)
    const cleanupMs = Date.now() - phaseStartedAt
    const durationMs = Date.now() - startedAt

    if (durationMs >= 2_000) {
      yield* Effect.logWarning("Slow Vélib collection", {
        observedAt,
        durationMs,
        fetchStatusMs,
        metadataMs,
        prepareSnapshotMs,
        persistSnapshotMs,
        createRollupsMs,
        cleanupMs,
        rollupSlot: observedAt % ROLLUP_SECONDS === 0
      })
    }

    const run: CollectionRecord = {
      observedAt,
      sourceUpdatedAt: status.sourceUpdatedAt,
      stationCount: status.stations.length,
      durationMs,
      status: collectionStatus,
      message: collectionStatus === "stale" ? "GBFS source timestamp did not advance" : null
    }
    yield* repository.recordCollection(run)
    yield* Effect.logInfo("Vélib collection completed", {
      observedAt,
      sourceUpdatedAt: status.sourceUpdatedAt,
      stationCount: status.stations.length,
      status: collectionStatus,
      durationMs: run.durationMs,
      liveChanges: liveUpdate?.changes.length ?? 0
    })
    return { liveUpdate } satisfies CollectionResult
  })

  return yield* collection.pipe(
    Effect.catch((error: AppError) =>
      Effect.gen(function*() {
        const run: CollectionRecord = {
          observedAt,
          sourceUpdatedAt: null,
          stationCount: null,
          durationMs: Date.now() - startedAt,
          status: "error",
          message: errorDetail(error)
        }
        yield* repository.recordCollection(run).pipe(
          Effect.catch(() => Effect.void)
        )
        yield* Effect.logError("Vélib collection failed", {
          observedAt,
          errorTag: error._tag,
          detail: errorDetail(error)
        })
        return yield* Effect.fail(error)
      })
    )
  )
})

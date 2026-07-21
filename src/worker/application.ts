import { Effect } from "effect"

import { compressSnapshot } from "./codec"
import {
  AppError,
  CollectionRecord,
  CompactSnapshot,
  ROLLUP_SECONDS,
  SnapshotRecord
} from "./domain"
import { GbfsClient } from "./gbfs"
import { deriveLiveUpdate } from "./live-update"
import { VelibRepository } from "./repository"

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
    const status = yield* client.fetchStatus()
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

    const snapshot = CompactSnapshot.make({ v: 1, s: status.stations })
    const record: SnapshotRecord = {
      observedAt,
      sourceUpdatedAt: status.sourceUpdatedAt,
      snapshot
    }
    const compressed = yield* compressSnapshot(snapshot)
    const persisted = yield* repository.persistSnapshot(record, compressed)
    const collectionStatus = persisted.status
    const liveUpdate = collectionStatus === "ok" && persisted.previous !== null
      ? deriveLiveUpdate(persisted.previous, record)
      : null

    if (observedAt % ROLLUP_SECONDS === 0) {
      // Finalize one bucket late so a delayed prior Cron can persist its last minute.
      const recentBuckets = Array.from(
        { length: 12 },
        (_, index) => observedAt - (index + 2) * ROLLUP_SECONDS
      )
      yield* Effect.forEach(
        recentBuckets,
        (bucketAt) => repository.createRollup(bucketAt),
        { discard: true }
      )
    }
    yield* repository.cleanup(observedAt)

    const run: CollectionRecord = {
      observedAt,
      sourceUpdatedAt: status.sourceUpdatedAt,
      stationCount: status.stations.length,
      durationMs: Date.now() - startedAt,
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
    return liveUpdate
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

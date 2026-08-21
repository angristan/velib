import type { Pipeline } from "cloudflare:pipelines"

import type { CompactStation } from "./domain"

export interface ArchiveBatch {
  readonly capacities: ReadonlyMap<number, number>
  readonly observedAt: number
  readonly sourceUpdatedAt: number
  readonly stations: ReadonlyArray<CompactStation>
}

export type StationObservationRecord =
  Cloudflare.VelibStationObservationsStreamV1Record

export type StationObservationPipeline = Pipeline<StationObservationRecord>

export interface ArchiveDelivery {
  readonly attempts: number
  readonly records: number
}

export interface ClaimedArchive extends ArchiveBatch {
  readonly attempts: number
}

export interface StationObservationOutbox {
  readonly claim: (
    now: number,
    limit: number,
    leaseUntil: number
  ) => Promise<ReadonlyArray<ClaimedArchive>>
  readonly complete: (observedAt: number) => Promise<void>
  readonly retry: (observedAt: number, nextAttemptAt: number) => Promise<void>
  readonly release: (
    observedAts: ReadonlyArray<number>,
    nextAttemptAt: number
  ) => Promise<void>
}

export interface ArchiveDrainDelivery extends ArchiveDelivery {
  readonly observedAt: number
  readonly sourceUpdatedAt: number
  readonly outboxAttempts: number
}

export interface ArchiveDrainResult {
  readonly claimed: number
  readonly deliveries: ReadonlyArray<ArchiveDrainDelivery>
  readonly failed: null | {
    readonly observedAt: number
    readonly sourceUpdatedAt: number
    readonly outboxAttempts: number
    readonly cause: unknown
  }
}

export interface ArchiveDrainOptions {
  readonly leaseSeconds?: number
  readonly limit?: number
  readonly wait?: (attempt: number) => Promise<void>
}

export const stationObservationRecords = (
  batch: ArchiveBatch
): Array<StationObservationRecord> => {
  const bucketAt = Math.floor(batch.observedAt / 300) * 300

  return batch.stations.map((station) => {
    const capacity = batch.capacities.get(station.c) ?? station.m + station.e + station.d

    return {
      event_id: `${batch.sourceUpdatedAt}:${station.c}`,
      observed_at: batch.observedAt,
      source_updated_at: batch.sourceUpdatedAt,
      bucket_at: bucketAt,
      station_code: station.c,
      capacity,
      mechanical: station.m,
      electric: station.e,
      docks: station.d,
      unavailable: Math.max(0, capacity - station.m - station.e - station.d),
      operative: station.o === 1,
      last_reported_at: station.r
    }
  })
}

const retryDelay = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, attempt * 250))

export const deliverStationObservations = async (
  pipeline: StationObservationPipeline,
  archive: ArchiveBatch,
  wait: (attempt: number) => Promise<void> = retryDelay
): Promise<ArchiveDelivery> => {
  const records = stationObservationRecords(archive)
  let lastFailure: unknown

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await pipeline.send(records)
      return { attempts: attempt, records: records.length }
    } catch (cause) {
      lastFailure = cause
      if (attempt < 3) await wait(attempt)
    }
  }

  throw lastFailure
}

export const archiveRetryDelaySeconds = (attempts: number): number =>
  Math.min(15 * 60, 60 * 2 ** Math.min(Math.max(0, attempts - 1), 4))

export const drainStationObservationOutbox = async (
  pipeline: StationObservationPipeline,
  outbox: StationObservationOutbox,
  now: number,
  options: ArchiveDrainOptions = {}
): Promise<ArchiveDrainResult> => {
  const limit = options.limit ?? 3
  const leaseUntil = now + (options.leaseSeconds ?? 180)
  const claims = await outbox.claim(now, limit, leaseUntil)
  const deliveries: Array<ArchiveDrainDelivery> = []

  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index]
    try {
      const delivery = await deliverStationObservations(
        pipeline,
        claim,
        options.wait ?? retryDelay
      )
      await outbox.complete(claim.observedAt)
      deliveries.push({
        ...delivery,
        observedAt: claim.observedAt,
        sourceUpdatedAt: claim.sourceUpdatedAt,
        outboxAttempts: claim.attempts
      })
    } catch (cause) {
      await outbox.retry(
        claim.observedAt,
        now + archiveRetryDelaySeconds(claim.attempts)
      )
      const unattempted = claims.slice(index + 1).map(({ observedAt }) => observedAt)
      if (unattempted.length > 0) {
        await outbox.release(unattempted, now + 60)
      }
      return {
        claimed: claims.length,
        deliveries,
        failed: {
          observedAt: claim.observedAt,
          sourceUpdatedAt: claim.sourceUpdatedAt,
          outboxAttempts: claim.attempts,
          cause
        }
      }
    }
  }

  return { claimed: claims.length, deliveries, failed: null }
}

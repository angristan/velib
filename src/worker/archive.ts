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

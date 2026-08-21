import { describe, expect, it } from "vitest"

import {
  archiveRetryDelaySeconds,
  deliverStationObservations,
  drainStationObservationOutbox,
  stationObservationRecords,
  type ClaimedArchive,
  type StationObservationOutbox,
  type StationObservationPipeline
} from "./archive"
import { CompactStation } from "./domain"

describe("stationObservationRecords", () => {
  it("maps one compact snapshot into deterministic flat records", () => {
    const records = stationObservationRecords({
      capacities: new Map([[2009, 20], [2010, 15]]),
      observedAt: 1_786_915_380,
      sourceUpdatedAt: 1_786_915_348,
      stations: [
        CompactStation.make({ c: 2009, m: 5, e: 2, d: 8, o: 1, r: 1_786_915_340 }),
        CompactStation.make({ c: 2010, m: 0, e: 1, d: 12, o: 0, r: 1_786_915_339 })
      ]
    })

    expect(records).toEqual([
      {
        event_id: "1786915348:2009",
        observed_at: 1_786_915_380,
        source_updated_at: 1_786_915_348,
        bucket_at: 1_786_915_200,
        station_code: 2009,
        capacity: 20,
        mechanical: 5,
        electric: 2,
        docks: 8,
        unavailable: 5,
        operative: true,
        last_reported_at: 1_786_915_340
      },
      {
        event_id: "1786915348:2010",
        observed_at: 1_786_915_380,
        source_updated_at: 1_786_915_348,
        bucket_at: 1_786_915_200,
        station_code: 2010,
        capacity: 15,
        mechanical: 0,
        electric: 1,
        docks: 12,
        unavailable: 2,
        operative: false,
        last_reported_at: 1_786_915_339
      }
    ])
  })

  it("keeps a production-sized batch below the Pipeline request limit", () => {
    const stations = Array.from({ length: 1_519 }, (_, index) =>
      CompactStation.make({
        c: 10_000 + index,
        m: index % 15,
        e: index % 7,
        d: 20 - index % 15,
        o: 1,
        r: 1_786_915_340
      })
    )
    const capacities = new Map(stations.map((station) => [station.c, 30]))
    const records = stationObservationRecords({
      capacities,
      observedAt: 1_786_915_380,
      sourceUpdatedAt: 1_786_915_348,
      stations
    })

    expect(new TextEncoder().encode(JSON.stringify(records)).byteLength).toBeLessThan(5_000_000)
  })

  it("retries Pipeline acceptance without rebuilding records", async () => {
    let attempts = 0
    const waits: number[] = []
    const pipeline: StationObservationPipeline = {
      send: async (records) => {
        attempts += 1
        expect(records).toHaveLength(1)
        if (attempts < 3) throw new Error("temporarily unavailable")
      }
    }

    const delivery = await deliverStationObservations(
      pipeline,
      {
        capacities: new Map([[2009, 20]]),
        observedAt: 1_786_915_380,
        sourceUpdatedAt: 1_786_915_348,
        stations: [
          CompactStation.make({ c: 2009, m: 5, e: 2, d: 8, o: 1, r: 1_786_915_340 })
        ]
      },
      async (attempt) => {
        waits.push(attempt)
      }
    )

    expect(delivery).toEqual({ attempts: 3, records: 1 })
    expect(waits).toEqual([1, 2])
  })

  it("drains claimed snapshots and defers work after a remote failure", async () => {
    const station = CompactStation.make({ c: 2009, m: 5, e: 2, d: 8, o: 1, r: 58 })
    const claim = (observedAt: number, attempts: number): ClaimedArchive => ({
      attempts,
      capacities: new Map([[2009, 20]]),
      observedAt,
      sourceUpdatedAt: observedAt - 2,
      stations: [station]
    })
    const claims = [claim(60, 1), claim(120, 2), claim(180, 1)]
    const completed: number[] = []
    const retried: Array<readonly [number, number]> = []
    const released: Array<readonly [ReadonlyArray<number>, number]> = []
    const sent: number[] = []
    const outbox: StationObservationOutbox = {
      claim: async () => claims,
      complete: async (observedAt) => {
        completed.push(observedAt)
      },
      retry: async (observedAt, nextAttemptAt) => {
        retried.push([observedAt, nextAttemptAt])
      },
      release: async (observedAts, nextAttemptAt) => {
        released.push([observedAts, nextAttemptAt])
      }
    }
    const pipeline: StationObservationPipeline = {
      send: async (records) => {
        const observedAt = records[0]?.observed_at ?? 0
        sent.push(observedAt)
        if (observedAt === 120) throw new Error("remote unavailable")
      }
    }

    const result = await drainStationObservationOutbox(pipeline, outbox, 1_000, {
      wait: async () => undefined
    })

    expect(result.claimed).toBe(3)
    expect(result.deliveries).toEqual([{
      attempts: 1,
      observedAt: 60,
      outboxAttempts: 1,
      records: 1,
      sourceUpdatedAt: 58
    }])
    expect(result.failed).toMatchObject({
      observedAt: 120,
      outboxAttempts: 2,
      sourceUpdatedAt: 118
    })
    expect(sent).toEqual([60, 120, 120, 120])
    expect(completed).toEqual([60])
    expect(retried).toEqual([[120, 1_120]])
    expect(released).toEqual([[[180], 1_060]])
  })

  it("caps archive retry backoff at fifteen minutes", () => {
    expect(archiveRetryDelaySeconds(1)).toBe(60)
    expect(archiveRetryDelaySeconds(2)).toBe(120)
    expect(archiveRetryDelaySeconds(5)).toBe(900)
    expect(archiveRetryDelaySeconds(20)).toBe(900)
  })
})

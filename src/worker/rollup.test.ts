import { assert, it } from "@effect/vitest"

import {
  CompactSnapshot,
  CompactStation,
  StationMetadata,
  type SnapshotRecord
} from "./domain"
import { deriveRollups } from "./rollup"

const snapshot = (
  observedAt: number,
  mechanical: number,
  electric: number,
  docks: number,
  operative: 0 | 1 = 1
): SnapshotRecord => ({
  observedAt,
  sourceUpdatedAt: observedAt,
  snapshot: CompactSnapshot.make({
    v: 1,
    s: [CompactStation.make({ c: 2009, m: mechanical, e: electric, d: docks, o: operative, r: observedAt })]
  })
})

it("derives availability and only counts movements across consecutive minutes", () => {
  const result = deriveRollups(
    1_000,
    [
      snapshot(1_000, 10, 2, 5),
      snapshot(1_060, 8, 3, 6),
      snapshot(1_180, 4, 6, 7, 0)
    ],
    [StationMetadata.make({
      stationCode: 2009,
      stationId: "2009",
      name: "Place de la Bourse",
      latitude: 48.869,
      longitude: 2.341,
      capacity: 20,
      metadataUpdatedAt: 1_000
    })]
  )

  const station = result.stations[0]
  assert.strictEqual(station.sampleCount, 3)
  assert.strictEqual(station.mechanical.min, 4)
  assert.strictEqual(station.mechanical.max, 10)
  assert.strictEqual(station.mechanical.avg, 22 / 3)
  assert.strictEqual(station.mechanicalRemoved, 2)
  assert.strictEqual(station.electricReturned, 1)
  assert.strictEqual(station.operativeSamples, 2)
  assert.strictEqual(station.unavailable.min, 3)
  assert.strictEqual(station.unavailable.max, 3)
  assert.strictEqual(station.unavailable.avg, 3)
})

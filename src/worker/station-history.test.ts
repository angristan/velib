import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { vi } from "vitest"

import {
  Aggregate,
  type HistoryResponse,
  type RollupHistoryPoint,
  StationMetadata
} from "./domain"
import { VelibRepository } from "./repository"
import { RollupArchive } from "./rollup-archive"
import { StationHistory, TieredStationHistoryLive } from "./station-history"

const metadata = StationMetadata.make({
  stationCode: 2009,
  stationId: "2009",
  name: "Place de la Bourse",
  latitude: 48.869,
  longitude: 2.341,
  capacity: 20,
  metadataUpdatedAt: 1_786_915_000
})

const point = (observedAt: number, average: number): RollupHistoryPoint => ({
  observedAt,
  sampleCount: 12,
  mechanical: Aggregate.make({ min: average - 1, max: average + 1, avg: average }),
  mechanicalRemoved: 1,
  mechanicalReturned: 2,
  electric: Aggregate.make({ min: 1, max: 3, avg: 2 }),
  electricRemoved: 1,
  electricReturned: 1,
  docks: Aggregate.make({ min: 8, max: 10, avg: 9 }),
  unavailable: Aggregate.make({ min: 0, max: 2, avg: 1 }),
  operativeSamples: 12
})

const unused = () => Effect.die("unused")

const makeRepository = (
  history: VelibRepository["Service"]["history"]
): VelibRepository["Service"] => ({
  capacities: unused,
  cleanup: unused,
  createRollups: unused,
  hasMetadata: unused,
  health: unused,
  history,
  latestSourceUpdatedAt: unused,
  live: unused,
  metadata: () => Effect.succeed(metadata),
  needsMetadata: unused,
  persistSnapshot: unused,
  recordCollection: unused,
  replay: unused,
  snapshot: unused,
  station: unused,
  syncMetadata: unused
})

const provideHistory = (
  repository: VelibRepository["Service"],
  archive: RollupArchive["Service"]
) => Layer.provide(
  TieredStationHistoryLive,
  Layer.merge(
    Layer.succeed(VelibRepository, repository),
    Layer.succeed(RollupArchive, archive)
  )
)

it.effect("keeps one-hour through seven-day history on D1", () => {
  const expected: HistoryResponse = {
    station: metadata,
    range: "7d",
    resolutionSeconds: 300,
    points: []
  }
  const history = vi.fn(() => Effect.succeed(expected))
  const hourlyHistory = vi.fn(() => Effect.succeed([]))

  return Effect.gen(function*() {
    const service = yield* StationHistory
    const result = yield* service.history(2009, "7d", 1_786_915_380)

    assert.deepEqual(result, expected)
    assert.strictEqual(history.mock.calls.length, 1)
    assert.strictEqual(hourlyHistory.mock.calls.length, 0)
  }).pipe(
    Effect.provide(provideHistory(makeRepository(history), {
      hourlyHistory,
      maintain: unused
    }))
  )
})

it.effect("overlays authoritative D1 points on archived 30-day history", () => {
  const now = 1_786_924_800
  const archived = [
    point(now - 9 * 60 * 60, 3),
    point(now - 8 * 60 * 60, 4)
  ]
  const hot = [
    point(now - 8 * 60 * 60, 8),
    point(now - 7 * 60 * 60, 9)
  ]
  const history = vi.fn(() => Effect.succeed({
    station: metadata,
    range: "7d" as const,
    resolutionSeconds: 300,
    points: hot
  }))
  const hourlyHistory = vi.fn(() => Effect.succeed(archived))

  return Effect.gen(function*() {
    const service = yield* StationHistory
    const result = yield* service.history(2009, "30d", now)

    assert.strictEqual(result.range, "30d")
    assert.strictEqual(result.resolutionSeconds, 60 * 60)
    assert.deepEqual(result.points.map((value) => [
      value.observedAt,
      "sampleCount" in value ? value.mechanical.avg : -1
    ]), [
      [now - 9 * 60 * 60, 3],
      [now - 8 * 60 * 60, 8],
      [now - 7 * 60 * 60, 9]
    ])
  }).pipe(
    Effect.provide(provideHistory(makeRepository(history), {
      hourlyHistory,
      maintain: unused
    }))
  )
})

it.effect("bounds one-year history at six-hour resolution", () => {
  const now = 1_786_924_800
  const archived = Array.from({ length: 12 }, (_, index) =>
    point(now - (12 - index) * 60 * 60, index + 1)
  )
  const history = vi.fn(() => Effect.succeed({
    station: metadata,
    range: "7d" as const,
    resolutionSeconds: 300,
    points: []
  }))

  return Effect.gen(function*() {
    const service = yield* StationHistory
    const result = yield* service.history(2009, "1y", now)

    assert.strictEqual(result.range, "1y")
    assert.strictEqual(result.resolutionSeconds, 6 * 60 * 60)
    assert.isAtMost(result.points.length, 3)
    assert.strictEqual(result.points.reduce(
      (sum, value) => sum + ("sampleCount" in value ? value.sampleCount : 0),
      0
    ), 12 * 12)
  }).pipe(
    Effect.provide(provideHistory(makeRepository(history), {
      hourlyHistory: () => Effect.succeed(archived),
      maintain: unused
    }))
  )
})

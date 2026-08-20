import { assert, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { expect, vi } from "vitest"

import {
  Aggregate,
  type HistoryResponse,
  StationMetadata
} from "./domain"
import { VelibRepository } from "./repository"
import {
  makeR2StationHistoryLive,
  r2HistorySql,
  StationHistory
} from "./station-history"

const metadata = StationMetadata.make({
  stationCode: 2009,
  stationId: "2009",
  name: "Place de la Bourse",
  latitude: 48.869,
  longitude: 2.341,
  capacity: 20,
  metadataUpdatedAt: 1_786_915_000
})

const unused = () => Effect.die("unused")

const makeRepository = (
  history: VelibRepository["Service"]["history"] = unused
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
  fetchImplementation: typeof fetch
) => Layer.provide(
  makeR2StationHistoryLive({
    accountId: "account-id",
    bucket: "velib-analytics",
    token: "test-token"
  }, fetchImplementation),
  Layer.succeed(VelibRepository, repository)
)

it("builds a bounded station query with bucket-local movement windows", () => {
  const sql = r2HistorySql(2009, "7d", 1_786_915_380)

  expect(sql).toContain("FROM velib.station_observations_v1")
  expect(sql).toContain("WHERE station_code = 2009")
  expect(sql).toContain("bucket_at >= 1786310580")
  expect(sql).toContain("bucket_at <= 1786914600")
  expect(sql).toContain("MIN(unavailable) AS unavailable_min")
  expect(sql).toContain("PARTITION BY bucket_at ORDER BY observed_at, source_updated_at")
  expect(sql).toContain("observed_at - previous_observed_at = 60")
  expect(sql).toContain("LIMIT 2020")
})

it("holds one full bucket for delayed observations at time boundaries", () => {
  expect(r2HistorySql(2009, "3h", 1_799)).toContain("bucket_at <= 900")
  expect(r2HistorySql(2009, "3h", 1_800)).toContain("bucket_at <= 1200")
  expect(r2HistorySql(2009, "3h", 1_801)).toContain("bucket_at <= 1200")
})

it.effect("maps R2 SQL rows into the existing history response", () => {
  let request: Request | undefined
  const fetchImplementation: typeof fetch = async (input, init) => {
    request = new Request(input, init)
    return Response.json({
      success: true,
      result: {
        request_id: "query-123",
        rows: [{
          bucket_at: "1786915200",
          sample_count: 5,
          mechanical_min: 2,
          mechanical_max: 6,
          mechanical_avg: 4,
          mechanical_removed: 3,
          mechanical_returned: 2,
          electric_min: 1,
          electric_max: 3,
          electric_avg: 2,
          electric_removed: 1,
          electric_returned: 1,
          docks_min: 10,
          docks_max: 14,
          docks_avg: 12,
          unavailable_min: 0,
          unavailable_max: 2,
          unavailable_avg: 1,
          operative_samples: 4
        }]
      },
      errors: [],
      messages: []
    })
  }

  return Effect.gen(function*() {
    const service = yield* StationHistory
    const history = yield* service.history(2009, "3h", 1_786_915_380)

    assert.strictEqual(history.station.stationCode, 2009)
    assert.strictEqual(history.range, "3h")
    assert.strictEqual(history.resolutionSeconds, 300)
    assert.deepEqual(history.points, [{
      observedAt: 1_786_915_200,
      sampleCount: 5,
      mechanical: Aggregate.make({ min: 2, max: 6, avg: 4 }),
      mechanicalRemoved: 3,
      mechanicalReturned: 2,
      electric: Aggregate.make({ min: 1, max: 3, avg: 2 }),
      electricRemoved: 1,
      electricReturned: 1,
      docks: Aggregate.make({ min: 10, max: 14, avg: 12 }),
      unavailable: Aggregate.make({ min: 0, max: 2, avg: 1 }),
      operativeSamples: 4
    }])
    assert.isDefined(request)
    assert.strictEqual(request.headers.get("authorization"), "Bearer test-token")
    assert.strictEqual(request.method, "POST")
    const requestBody = yield* Effect.promise(() => request?.text() ?? Promise.resolve(""))
    assert.include(requestBody, "station_code = 2009")
  }).pipe(
    Effect.provide(provideHistory(makeRepository(), fetchImplementation))
  )
})

it.effect("fails closed when R2 SQL rejects a history query", () => {
  const fetchImplementation: typeof fetch = async () => Response.json({
    success: false,
    errors: [{ code: 1000, message: "query unavailable" }]
  }, { status: 503 })

  return Effect.gen(function*() {
    const service = yield* StationHistory
    const error = yield* Effect.flip(service.history(2009, "7d", 1_786_915_380))

    assert.strictEqual(error._tag, "StationHistoryError")
    if (error._tag === "StationHistoryError") {
      assert.strictEqual(error.operation, "r2Sql.query")
    }
  }).pipe(
    Effect.provide(provideHistory(makeRepository(), fetchImplementation))
  )
})

it.effect("keeps exact one-hour history on D1", () => {
  const expected: HistoryResponse = {
    station: metadata,
    range: "1h",
    resolutionSeconds: 60,
    points: []
  }
  const history = vi.fn(() => Effect.succeed(expected))
  const fetchImplementation = vi.fn<typeof fetch>()

  return Effect.gen(function*() {
    const service = yield* StationHistory
    const result = yield* service.history(2009, "1h", 1_786_915_380)

    assert.deepEqual(result, expected)
    assert.strictEqual(history.mock.calls.length, 1)
    assert.strictEqual(fetchImplementation.mock.calls.length, 0)
  }).pipe(
    Effect.provide(provideHistory(makeRepository(history), fetchImplementation))
  )
})

import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

import { GbfsClient, GbfsClientLive } from "./gbfs"

const statusFeed = (...stations: Array<Record<string, unknown>>) => ({
  data: { stations },
  lastUpdatedOther: 1_784_625_000,
  ttl: 60,
})

const station = (overrides: Record<string, unknown> = {}) => ({
  is_installed: 1,
  is_renting: 1,
  is_returning: 1,
  last_reported: 1_784_624_980,
  num_bikes_available_types: [{ mechanical: 3 }, { ebike: 2 }],
  num_docks_available: 10,
  stationCode: "2009",
  station_id: "2009",
  ...overrides,
})

const informationFeed = (...stations: Array<Record<string, unknown>>) => ({
  data: { stations },
  lastUpdatedOther: 1_784_624_900,
  ttl: 3_600,
})

const informationStation = (
  stationId: string,
  stationCode: string,
): Record<string, unknown> => ({
  station_id: stationId,
  stationCode,
  name: `Station ${stationCode}`,
  lat: 48.85,
  lon: 2.35,
  capacity: 20,
})

const mockFeeds = (status: unknown, information?: unknown) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const isInformation = String(input).includes("station_information.json")
    if (isInformation && information === undefined) {
      return new Response("missing information fixture", { status: 500 })
    }
    return new Response(JSON.stringify(isInformation ? information : status), {
      headers: { "Content-Type": "application/json" },
    })
  })

const runFetchStatus = async (input: unknown, information?: unknown) => {
  const fetchMock = mockFeeds(input, information)

  try {
    return await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* GbfsClient
        return yield* client.fetchStatus()
      }).pipe(Effect.provide(GbfsClientLive)),
    )
  } finally {
    fetchMock.mockRestore()
  }
}

const fetchStatusError = async (input: unknown, information?: unknown) => {
  const fetchMock = mockFeeds(input, information)

  try {
    return await Effect.runPromise(
      Effect.gen(function*() {
        const client = yield* GbfsClient
        return yield* client.fetchStatus().pipe(Effect.flip)
      }).pipe(Effect.provide(GbfsClientLive)),
    )
  } finally {
    fetchMock.mockRestore()
  }
}

it("normalizes validated station status in one collection", async () => {
  const result = await runFetchStatus(statusFeed(station({
    is_installed: true,
    num_bikes_available_types: [
      { mechanical: 3 },
      { mechanical: 2, ebike: 4 },
    ],
  })))

  assert.deepEqual(result, {
    sourceUpdatedAt: 1_784_625_000,
    stations: [{
      c: 2009,
      m: 5,
      e: 4,
      d: 10,
      o: 1,
      r: 1_784_624_980,
    }],
  })
})

it("recovers a fully code-less status feed from authoritative information", async () => {
  const statusStations = Array.from({ length: 6 }, (_, index) => station({
    stationCode: null,
    station_id: `station-${index}`,
  }))
  const informationStations = Array.from({ length: 6 }, (_, index) =>
    informationStation(`station-${index}`, String(3_000 + index)))

  const result = await runFetchStatus(
    statusFeed(...statusStations),
    informationFeed(...informationStations),
  )

  assert.deepEqual(result.stations.map(({ c }) => c), [3_000, 3_001, 3_002, 3_003, 3_004, 3_005])
})

it("fails when authoritative information cannot resolve every missing code", async () => {
  const error = await fetchStatusError(
    statusFeed(station({ stationCode: null, station_id: "missing" })),
    informationFeed(),
  )

  assert.strictEqual(error._tag, "FeedError")
  assert.strictEqual(error.operation, "resolveStatusStationCode")
})

it("fails when authoritative information contains duplicate station IDs", async () => {
  const error = await fetchStatusError(
    statusFeed(station({ stationCode: null, station_id: "duplicate" })),
    informationFeed(
      informationStation("duplicate", "3000"),
      informationStation("duplicate", "3001"),
    ),
  )

  assert.strictEqual(error._tag, "FeedError")
  assert.strictEqual(error.operation, "resolveStatusStationCode")
})

it("fails when authoritative information resolves duplicate station codes", async () => {
  const error = await fetchStatusError(
    statusFeed(
      station({ stationCode: null, station_id: "first" }),
      station({ stationCode: null, station_id: "second" }),
    ),
    informationFeed(
      informationStation("first", "3000"),
      informationStation("second", "3000"),
    ),
  )

  assert.strictEqual(error._tag, "FeedError")
  assert.strictEqual(error.operation, "resolveStatusStationCode")
})

it("skips an isolated malformed upstream row", async () => {
  const result = await runFetchStatus(statusFeed(
    station({ num_docks_available: null, station_id: "placeholder" }),
    station(),
  ))

  assert.deepEqual(result.stations.map(({ c }) => c), [2009])
})

it("rejects broadly malformed status feeds", async () => {
  const error = await fetchStatusError(statusFeed(
    ...Array.from({ length: 6 }, (_, index) => station({
      num_docks_available: null,
      station_id: `placeholder-${index}`,
    })),
  ))

  assert.strictEqual(error._tag, "FeedError")
  assert.strictEqual(error.operation, "decodeStatusStation")
})

it("reports out-of-domain station codes as FeedError", async () => {
  const error = await fetchStatusError(statusFeed(station({ stationCode: "1000000" })))

  assert.strictEqual(error._tag, "FeedError")
  assert.strictEqual(error.operation, "decodeStatusStation")
})

it("reports excessive aggregate bike counts as FeedError", async () => {
  const error = await fetchStatusError(statusFeed(station({
    num_bikes_available_types: [{ mechanical: 6_000 }, { mechanical: 6_000 }],
  })))

  assert.strictEqual(error._tag, "FeedError")
  assert.strictEqual(error.operation, "decodeStatusStation")
})

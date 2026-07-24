import { assert, it } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vitest"

import { GbfsClient, GbfsClientLive } from "./gbfs"

const statusFeed = (station: Record<string, unknown>) => ({
  data: { stations: [station] },
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

const fetchStatusError = async (input: unknown) => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(input), {
      headers: { "Content-Type": "application/json" },
    }),
  )

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

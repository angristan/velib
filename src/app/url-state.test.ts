import { assert, it } from "@effect/vitest"

import { clearAppUrlState, parseAppUrlState, serializeAppUrlState } from "./url-state"

it("round-trips archive comparison and map state", () => {
  const state = parseAppUrlState(
    "?station=1001&q=horloge&filter=electric&mode=replay&at=1784625060&from=1784538660&span=7d&layer=heatmap&lat=48.85600&lng=2.34200&z=15.25",
  )
  const url = serializeAppUrlState(state, "https://velib.example/")
  const serialized = new URL(url)
  const restored = parseAppUrlState(serialized.search)

  assert.strictEqual(serialized.searchParams.get("at"), "1784625060")
  assert.strictEqual(serialized.searchParams.get("from"), "1784538660")
  assert.strictEqual(serialized.searchParams.get("span"), "7d")
  assert.strictEqual(serialized.searchParams.get("lat"), "48.85600")
  assert.strictEqual(serialized.searchParams.get("lng"), "2.34200")
  assert.strictEqual(serialized.searchParams.get("z"), "15.25")
  assert.deepEqual(restored, state)
})

it("keeps legacy replay links on the latest archive point", () => {
  const state = parseAppUrlState("?mode=replay&window=30")

  assert.strictEqual(state.mode, "replay")
  assert.isNull(state.replayAt)
  assert.strictEqual(state.timelineMode, "explore")
  assert.strictEqual(state.timelineRange, "1h")
})

it("clears shared query parameters without changing the page", () => {
  assert.strictEqual(
    clearAppUrlState("https://velib.example/?mode=replay&lat=48.85#map"),
    "https://velib.example/#map",
  )
})

it("rejects malformed enums, timestamps, station IDs, and camera coordinates", () => {
  const state = parseAppUrlState(
    "?station=nope&filter=broken&mode=replay&at=tomorrow&from=12&span=forever&layer=fire&lat=999&lng=-999&z=50",
  )

  assert.isNull(state.selectedCode)
  assert.strictEqual(state.filter, "all")
  assert.strictEqual(state.mode, "replay")
  assert.isNull(state.replayAt)
  assert.isNull(state.comparisonFromAt)
  assert.strictEqual(state.timelineMode, "explore")
  assert.strictEqual(state.timelineRange, "1h")
  assert.strictEqual(state.mapMode, "stations")
  assert.strictEqual(state.camera.zoom, 12.15)
})

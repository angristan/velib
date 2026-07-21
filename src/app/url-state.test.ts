import { assert, it } from "@effect/vitest"

import { parseAppUrlState, serializeAppUrlState } from "./url-state"

it("round-trips durable replay and map state", () => {
  const state = parseAppUrlState(
    "?station=1001&q=horloge&filter=electric&mode=replay&window=30&at=1784625060&layer=heatmap&lat=48.85600&lng=2.34200&z=15.25",
  )
  const url = serializeAppUrlState(state, "https://velib.example/")
  const restored = parseAppUrlState(new URL(url).search)

  assert.deepEqual(restored, state)
})

it("rejects malformed enums, station IDs, and camera coordinates", () => {
  const state = parseAppUrlState(
    "?station=nope&filter=broken&mode=broken&window=999&layer=fire&lat=999&lng=-999&z=50",
  )

  assert.isNull(state.selectedCode)
  assert.strictEqual(state.filter, "all")
  assert.strictEqual(state.mode, "live")
  assert.strictEqual(state.replayMinutes, 15)
  assert.strictEqual(state.mapMode, "stations")
  assert.strictEqual(state.camera.zoom, 12.15)
})

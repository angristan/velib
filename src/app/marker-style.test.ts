import { assert, it } from "vitest"
import {
  availabilityBins,
  availabilityMarkerKey,
} from "./marker-style"

it("allocates mechanical, electric, dock, and unavailable capacity proportionally", () => {
  const station = { capacity: 20, mechanical: 6, electric: 4, docks: 8 }

  assert.deepEqual(availabilityBins(station), {
    mechanical: 3,
    electric: 2,
    docks: 4,
    unavailable: 1,
  })
  assert.strictEqual(availabilityMarkerKey(station), "availability-3-2-4")
})

it("keeps inconsistent feed totals within the ten-part marker", () => {
  const bins = availabilityBins({
    capacity: 10,
    mechanical: 8,
    electric: 5,
    docks: 3,
  })

  assert.deepEqual(bins, {
    mechanical: 5,
    electric: 3,
    docks: 2,
    unavailable: 0,
  })
  assert.strictEqual(
    bins.mechanical + bins.electric + bins.docks + bins.unavailable,
    10,
  )
})

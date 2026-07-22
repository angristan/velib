import { assert, it } from "@effect/vitest"

import { updateWhenMapResourceAvailable } from "./map-readiness"

it("updates immediately once the map resource exists", () => {
  let updates = 0
  let waits = 0

  const cleanup = updateWhenMapResourceAvailable(
    () => true,
    () => { updates += 1 },
    () => {
      waits += 1
      return () => undefined
    },
  )

  assert.strictEqual(updates, 1)
  assert.strictEqual(waits, 0)
  assert.isUndefined(cleanup)
})

it("waits for initial map load and returns listener cleanup", () => {
  let listener: (() => void) | undefined
  let cleaned = false
  let updates = 0

  const cleanup = updateWhenMapResourceAvailable(
    () => false,
    () => { updates += 1 },
    (nextListener) => {
      listener = nextListener
      return () => { cleaned = true }
    },
  )

  assert.strictEqual(updates, 0)
  listener?.()
  assert.strictEqual(updates, 1)
  cleanup?.()
  assert.isTrue(cleaned)
})

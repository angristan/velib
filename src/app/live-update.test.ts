import { assert, it } from "@effect/vitest"

import { applyLiveUpdate } from "./live-update"
import type { LiveData, LiveUpdate } from "./types"

const current: LiveData = {
  observedAt: 60_000,
  sourceUpdatedAt: 58_000,
  stations: [{
    code: "1001",
    id: "1001",
    name: "Quai de l'Horloge",
    latitude: 48.856,
    longitude: 2.342,
    capacity: 20,
    mechanical: 4,
    electric: 2,
    docks: 12,
    unavailable: 2,
    isInstalled: true,
    isRenting: true,
    isReturning: true
  }]
}

const update: LiveUpdate = {
  observedAt: 120_000,
  previousSourceUpdatedAt: 58_000,
  sourceUpdatedAt: 118_000,
  changes: [{
    code: "1001",
    mechanical: 2,
    electric: 3,
    docks: 13,
    operative: true,
    mechanicalDelta: -2,
    electricDelta: 1,
    docksDelta: 1
  }]
}

it("applies absolute live station values", () => {
  const next = applyLiveUpdate(current, update)

  assert.isNotNull(next)
  assert.strictEqual(next?.sourceUpdatedAt, 118_000)
  assert.strictEqual(next?.stations[0]?.mechanical, 2)
  assert.strictEqual(next?.stations[0]?.electric, 3)
  assert.strictEqual(next?.stations[0]?.unavailable, 2)
})

it("rejects an update when an intermediate event was missed", () => {
  const outOfSequence = {
    ...update,
    previousSourceUpdatedAt: 59_000
  }

  assert.isNull(applyLiveUpdate(current, outOfSequence))
})

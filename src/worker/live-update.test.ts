import { describe, expect, it } from "vitest"

import { CompactSnapshot } from "./domain"
import { deriveLiveUpdate } from "./live-update"

const snapshot = (
  observedAt: number,
  sourceUpdatedAt: number,
  stations: CompactSnapshot["s"]
) => ({
  observedAt,
  sourceUpdatedAt,
  snapshot: CompactSnapshot.make({ v: 1, s: stations })
})

describe("deriveLiveUpdate", () => {
  it("emits compact absolute values and signed deltas", () => {
    const previous = snapshot(60, 58, [
      { c: 1001, m: 4, e: 2, d: 8, o: 1, r: 55 },
      { c: 1002, m: 1, e: 0, d: 9, o: 1, r: 55 }
    ])
    const current = snapshot(120, 118, [
      { c: 1001, m: 2, e: 3, d: 9, o: 1, r: 115 },
      { c: 1002, m: 1, e: 0, d: 9, o: 1, r: 115 }
    ])

    const update = deriveLiveUpdate(previous, current)

    expect(update.previousSourceUpdatedAt).toBe(58)
    expect(update.sourceUpdatedAt).toBe(118)
    expect(update.changes).toHaveLength(1)
    expect(update.changes[0]?.c).toBe(1001)
    expect(update.changes[0]?.m).toBe(2)
    expect(update.changes[0]?.e).toBe(3)
    expect(update.changes[0]?.d).toBe(9)
    expect(update.changes[0]?.dm).toBe(-2)
    expect(update.changes[0]?.de).toBe(1)
    expect(update.changes[0]?.dd).toBe(1)
  })

  it("marks omitted stations unavailable and restores them without fake movement", () => {
    const available = snapshot(60, 58, [
      { c: 1001, m: 4, e: 2, d: 8, o: 1, r: 55 }
    ])
    const omitted = snapshot(120, 118, [])
    const restored = snapshot(180, 178, [
      { c: 1001, m: 3, e: 3, d: 8, o: 1, r: 175 }
    ])

    expect(deriveLiveUpdate(available, omitted).changes[0]).toMatchObject({
      c: 1001,
      m: 0,
      e: 0,
      d: 0,
      o: 0,
      dm: 0,
      de: 0,
      dd: 0
    })
    expect(deriveLiveUpdate(omitted, restored).changes[0]).toMatchObject({
      c: 1001,
      m: 3,
      e: 3,
      d: 8,
      o: 1,
      dm: 0,
      de: 0,
      dd: 0
    })
  })

  it("emits an empty heartbeat when availability is unchanged", () => {
    const previous = snapshot(60, 58, [
      { c: 1001, m: 4, e: 2, d: 8, o: 1, r: 55 }
    ])
    const current = snapshot(120, 118, [
      { c: 1001, m: 4, e: 2, d: 8, o: 1, r: 115 }
    ])

    expect(deriveLiveUpdate(previous, current).changes).toHaveLength(0)
  })
})

import { assert, it } from "@effect/vitest"
import { vi } from "vitest"

import {
  decodeLiveData,
  decodeLiveUpdate,
  decodeReplayData,
  decodeStationHistory,
  fetchLiveData,
} from "./api"

it("requests the uncached current live state by default", async () => {
  const now = 1_784_625_123_456
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    observedAt: 1_784_625_120,
    sourceUpdatedAt: 1_784_625_100,
    stations: [],
  })))

  try {
    await fetchLiveData(new AbortController().signal)

    const [path, init] = fetchMock.mock.calls[0] ?? []
    const reconcileKey = Math.floor(now / 60_000) * 60_000
    assert.strictEqual(path, `/api/live?reconcile=${reconcileKey}`)
    assert.strictEqual(init?.cache, "no-store")
  } finally {
    fetchMock.mockRestore()
    vi.useRealTimers()
  }
})

it("decodes live Worker responses without inventing operational flags", () => {
  const decoded = decodeLiveData({
    observedAt: 1_784_625_000,
    sourceUpdatedAt: 1_784_624_980,
    stations: [{
      stationCode: 2009,
      stationId: "2009",
      name: "Place de la Bourse",
      latitude: 48.869,
      longitude: 2.341,
      capacity: 20,
      mechanical: 8,
      electric: 3,
      docks: 6,
      unavailable: 3,
      operative: false
    }]
  })

  assert.isNotNull(decoded)
  assert.strictEqual(decoded?.observedAt, 1_784_625_000_000)
  assert.isFalse(decoded?.stations[0]?.isInstalled ?? true)
  assert.isFalse(decoded?.stations[0]?.isRenting ?? true)
  assert.isFalse(decoded?.stations[0]?.isReturning ?? true)
})

it("decodes compact signed live updates", () => {
  const decoded = decodeLiveUpdate({
    v: 1,
    observedAt: 1_784_625_060,
    previousSourceUpdatedAt: 1_784_624_980,
    sourceUpdatedAt: 1_784_625_040,
    changes: [{ c: 2009, m: 7, e: 4, d: 6, o: 1, dm: -1, de: 1, dd: 0 }]
  })

  assert.isNotNull(decoded)
  assert.strictEqual(decoded?.sourceUpdatedAt, 1_784_625_040_000)
  assert.strictEqual(decoded?.changes[0]?.code, "2009")
  assert.strictEqual(decoded?.changes[0]?.mechanicalDelta, -1)
  assert.strictEqual(decoded?.changes[0]?.electricDelta, 1)
})

it("rejects non-monotonic or invalid live updates", () => {
  assert.isNull(decodeLiveUpdate({
    v: 1,
    observedAt: 1_784_625_060,
    previousSourceUpdatedAt: 1_784_625_040,
    sourceUpdatedAt: 1_784_625_040,
    changes: [{ c: 2009, m: -1, e: 4, d: 6, o: 1, dm: -1, de: 1, dd: 0 }]
  }))
})

it("decodes compact replay baselines with a strict frame chain", () => {
  const input = {
    v: 1,
    minutes: 15,
    generatedAt: 1_784_625_180,
    from: 1_784_624_080,
    to: 1_784_625_120,
    baseline: {
      observedAt: 1_784_624_080,
      sourceUpdatedAt: 1_784_624_060,
      stations: [{ c: 2009, m: 8, e: 3, d: 6, o: 1, r: 1_784_624_060 }],
    },
    frames: [{
      v: 1,
      observedAt: 1_784_624_140,
      previousSourceUpdatedAt: 1_784_624_060,
      sourceUpdatedAt: 1_784_624_120,
      changes: [{ c: 2009, m: 7, e: 4, d: 6, o: 1, dm: -1, de: 1, dd: 0 }],
    }],
  }

  const decoded = decodeReplayData(input)
  assert.isNotNull(decoded)
  assert.strictEqual(decoded?.baseline.stations[0]?.code, "2009")
  assert.strictEqual(decoded?.frames[0]?.previousSourceUpdatedAt, 1_784_624_060_000)

  assert.isNull(decodeReplayData({
    ...input,
    frames: [{ ...input.frames[0], previousSourceUpdatedAt: 1_784_624_000 }],
  }))
})

it("uses aggregate averages and movement totals for history charts", () => {
  const decoded = decodeStationHistory({
    points: [{
      observedAt: 1_784_625_000,
      mechanical: { min: 4, max: 8, avg: 6 },
      electric: { min: 2, max: 4, avg: 3 },
      docks: { min: 9, max: 12, avg: 10.5 },
      unavailable: { min: 0, max: 1, avg: 0.5 },
      mechanicalRemoved: 2,
      electricRemoved: 1,
      mechanicalReturned: 1,
      electricReturned: 2
    }]
  }, "2009", "3h")

  assert.deepEqual(decoded.points[0], {
    at: 1_784_625_000_000,
    mechanical: 6,
    electric: 3,
    docks: 10.5,
    unavailable: 0.5,
    removed: 3,
    returned: 3
  })
})

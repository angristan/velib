import { assert, it } from "@effect/vitest"

import {
  ARCHIVE_RETENTION_MS,
  ARCHIVE_SCALE_MAX,
  archiveScaleLandmarks,
  archiveScalePosition,
  archiveTimestampAtScale,
  clampTimelineAt,
  compareSnapshots,
  defaultComparison,
  timelineBounds,
  timelineTicks,
} from "./archive"
import type { LiveData, Station } from "./types"

const station = (overrides: Partial<Station> = {}): Station => ({
  capacity: 20,
  code: "1001",
  docks: 7,
  electric: 4,
  id: "1001",
  isInstalled: true,
  isRenting: true,
  isReturning: true,
  latitude: 48.856,
  longitude: 2.342,
  mechanical: 9,
  name: "Quai de l’Horloge",
  unavailable: 0,
  ...overrides,
})

const snapshot = (at: number, stations: readonly Station[]): LiveData => ({
  observedAt: at,
  sourceUpdatedAt: at,
  stations,
})

it("uses minute detail nearby and five-minute steps when zoomed out", () => {
  const latestAt = 1_800_000_000_000

  assert.deepEqual(timelineBounds(latestAt, "1h"), {
    min: latestAt - 3_600_000,
    max: latestAt,
    step: 60_000,
  })
  assert.deepEqual(timelineBounds(latestAt, "7d"), {
    min: latestAt - 604_800_000,
    max: latestAt,
    step: 300_000,
  })
})

it("creates evenly spaced semantic timeline landmarks", () => {
  assert.deepEqual(timelineTicks(0, 60, 5), [0, 15, 30, 45, 60])
})

it("maps the full retention window onto one reversible logarithmic scale", () => {
  const latestAt = 1_800_000_000_000
  assert.strictEqual(archiveScalePosition(latestAt - ARCHIVE_RETENTION_MS, latestAt), 0)
  assert.strictEqual(archiveScalePosition(latestAt, latestAt), ARCHIVE_SCALE_MAX)

  for (const age of [15 * 60_000, 3_600_000, 6 * 3_600_000, 86_400_000, 3 * 86_400_000]) {
    const timestamp = latestAt - age
    const restored = archiveTimestampAtScale(archiveScalePosition(timestamp, latestAt), latestAt)
    assert.isAtMost(Math.abs(restored - timestamp), 60_000)
  }
})

it("gives recent minutes more room than several older days", () => {
  const latestAt = 1_800_000_000_000
  const landmarks = archiveScaleLandmarks(latestAt)
  const positions = Object.fromEntries(landmarks.map((landmark) => [landmark.label, landmark.position]))
  const recentWidth = positions.Maintenant - positions["−15 min"]
  const olderWidth = positions["−3 j"] - positions["−7 j"]

  assert.isAbove(recentWidth, olderWidth)
  assert.deepEqual(landmarks.map((landmark) => landmark.label), [
    "−7 j", "−3 j", "−24 h", "−6 h", "−1 h", "−15 min", "Maintenant",
  ])
})

it("clamps archive selections and creates an ordered comparison", () => {
  const latestAt = 1_800_000_000_000
  assert.strictEqual(clampTimelineAt(latestAt - 10_000_000, latestAt, "1h"), latestAt - 3_600_000)
  assert.deepEqual(defaultComparison(latestAt, latestAt, "1h"), [
    latestAt - 900_000,
    latestAt,
  ])
})

it("omits unchanged stations from comparison activity", () => {
  const unchanged = station()
  assert.deepEqual(compareSnapshots(snapshot(1_000, [unchanged]), snapshot(2_000, [unchanged])), [])
})

it("computes explicit B minus A changes from historical snapshots", () => {
  const from = snapshot(1_000, [station()])
  const to = snapshot(2_000, [station({ docks: 8, electric: 2, mechanical: 11 })])
  const changes = compareSnapshots(from, to)

  assert.deepEqual(changes, [{
    code: "1001",
    docks: 8,
    docksDelta: 1,
    electric: 2,
    electricDelta: -2,
    mechanical: 11,
    mechanicalDelta: 2,
    operative: true,
  }])
})

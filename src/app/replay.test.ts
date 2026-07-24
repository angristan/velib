import { assert, it } from "@effect/vitest"

import {
  appendReplayUpdate,
  appendReplayUpdates,
  archiveSnapshotDataAt,
  latestReplayUpdate,
  mergeReplayRefresh,
  nearestReplayCursor,
  replayDataAt,
  stationTrend,
} from "./replay"
import type { ReplayData, Station } from "./types"

const station: Station = {
  code: "1001",
  id: "1001",
  name: "Quai de l’Horloge",
  latitude: 48.856,
  longitude: 2.342,
  capacity: 20,
  mechanical: 9,
  electric: 4,
  docks: 7,
  unavailable: 0,
  isInstalled: true,
  isRenting: true,
  isReturning: true,
}

const replay: ReplayData = {
  minutes: 15,
  generatedAt: 240_000,
  from: 60_000,
  to: 180_000,
  baseline: {
    observedAt: 60_000,
    sourceUpdatedAt: 58_000,
    stations: [{ code: "1001", mechanical: 4, electric: 2, docks: 14, operative: true }],
  },
  frames: [
    {
      observedAt: 120_000,
      previousSourceUpdatedAt: 58_000,
      sourceUpdatedAt: 118_000,
      changes: [{
        code: "1001",
        mechanical: 6,
        electric: 2,
        docks: 12,
        operative: true,
        mechanicalDelta: 2,
        electricDelta: 0,
        docksDelta: -2,
      }],
    },
    {
      observedAt: 180_000,
      previousSourceUpdatedAt: 118_000,
      sourceUpdatedAt: 178_000,
      changes: [{
        code: "1001",
        mechanical: 5,
        electric: 1,
        docks: 14,
        operative: true,
        mechanicalDelta: -1,
        electricDelta: -1,
        docksDelta: 2,
      }],
    },
  ],
}

it("builds a map state from one compact archive snapshot", () => {
  const snapshot = archiveSnapshotDataAt([station], replay.baseline)

  assert.strictEqual(snapshot.sourceUpdatedAt, 58_000)
  assert.strictEqual(snapshot.stations[0]?.mechanical, 4)
  assert.strictEqual(snapshot.stations[0]?.docks, 14)
})

it("reconstructs a historical station snapshot at any cursor", () => {
  const first = replayDataAt([station], replay, 1)
  const last = replayDataAt([station], replay, 2)

  assert.strictEqual(first.stations[0]?.mechanical, 6)
  assert.strictEqual(last.stations[0]?.mechanical, 5)
  assert.strictEqual(last.stations[0]?.electric, 1)
  assert.strictEqual(last.sourceUpdatedAt, 178_000)
})

it("finds shared replay positions and derives a selected-station streak", () => {
  assert.strictEqual(nearestReplayCursor(replay, 120_000), 1)
  assert.deepEqual(stationTrend(replay, "1001").deltas, [2, -2])
  assert.deepEqual(stationTrend(replay, "1001").points, [0, 2, 0])
})

it("uses the latest replay update for initial live activity", () => {
  assert.strictEqual(latestReplayUpdate(replay), replay.frames[1])
  assert.isNull(latestReplayUpdate(null))
})

it("reconciles every WebSocket update queued during a refresh", () => {
  const first = {
    observedAt: 240_000,
    previousSourceUpdatedAt: 178_000,
    sourceUpdatedAt: 238_000,
    changes: [],
  }
  const second = {
    observedAt: 300_000,
    previousSourceUpdatedAt: 238_000,
    sourceUpdatedAt: 298_000,
    changes: [],
  }

  const reconciled = appendReplayUpdates(replay, [first, second])
  assert.isNotNull(reconciled)
  assert.strictEqual(reconciled?.frames.at(-1)?.sourceUpdatedAt, 298_000)
  assert.isNull(appendReplayUpdates(replay, [second]))
})

it("keeps newer socket frames when a Query refresh completes", () => {
  const first = {
    observedAt: 240_000,
    previousSourceUpdatedAt: 178_000,
    sourceUpdatedAt: 238_000,
    changes: [],
  }
  const second = {
    observedAt: 300_000,
    previousSourceUpdatedAt: 238_000,
    sourceUpdatedAt: 298_000,
    changes: [],
  }
  const liveReplay = appendReplayUpdates(replay, [first, second])
  assert.isNotNull(liveReplay)

  const merged = mergeReplayRefresh(liveReplay, replay)
  assert.strictEqual(merged?.frames.at(-1)?.sourceUpdatedAt, 298_000)
})

it("advances the replay window with sequential WebSocket updates", () => {
  const update = {
    observedAt: 1_102_000,
    previousSourceUpdatedAt: 178_000,
    sourceUpdatedAt: 1_100_000,
    changes: [{
      code: "1001",
      mechanical: 7,
      electric: 1,
      docks: 12,
      operative: true,
      mechanicalDelta: 2,
      electricDelta: 0,
      docksDelta: -2,
    }],
  }
  const next = appendReplayUpdate(replay, update)

  assert.strictEqual(next.baseline.sourceUpdatedAt, 178_000)
  assert.strictEqual(next.baseline.stations[0]?.mechanical, 5)
  assert.strictEqual(next.frames.length, 1)
  assert.strictEqual(replayDataAt([station], next, 1).stations[0]?.mechanical, 7)
  assert.strictEqual(appendReplayUpdate(next, update), next)
})

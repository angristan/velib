import { applyLiveUpdate } from "./live-update"
import type {
  LiveData,
  LiveStationChange,
  LiveUpdate,
  ReplayData,
  Station,
  StationTrend,
} from "./types"

export const replayDataAt = (
  metadata: readonly Station[],
  replay: ReplayData,
  cursor: number,
): LiveData => {
  const baseline = new Map(replay.baseline.stations.map((station) => [station.code, station]))
  const stations: Station[] = []
  for (const station of metadata) {
    const state = baseline.get(station.code)
    if (state === undefined) {
      stations.push({
        ...station,
        mechanical: 0,
        electric: 0,
        docks: 0,
        unavailable: station.capacity,
        isInstalled: false,
        isRenting: false,
        isReturning: false,
      })
      continue
    }
    stations.push({
      ...station,
      mechanical: state.mechanical,
      electric: state.electric,
      docks: state.docks,
      unavailable: Math.max(
        0,
        station.capacity - state.mechanical - state.electric - state.docks,
      ),
      isInstalled: state.operative,
      isRenting: state.operative,
      isReturning: state.operative,
    })
  }

  let current: LiveData = {
    observedAt: replay.baseline.observedAt,
    sourceUpdatedAt: replay.baseline.sourceUpdatedAt,
    stations,
  }
  const end = Math.min(Math.max(0, cursor), replay.frames.length)
  for (let index = 0; index < end; index += 1) {
    const frame = replay.frames[index]
    if (frame === undefined) break
    const next = applyLiveUpdate(current, frame)
    if (next !== null) current = next
  }
  return current
}

export const replayUpdateAt = (
  replay: ReplayData | null,
  cursor: number,
): LiveUpdate | null => {
  if (replay === null || cursor <= 0) return null
  return replay.frames[Math.min(cursor, replay.frames.length) - 1] ?? null
}

export const nearestReplayCursor = (replay: ReplayData, timestamp: number): number => {
  let nearest = 0
  let distance = Math.abs(timestamp - replay.baseline.sourceUpdatedAt)
  for (let index = 0; index < replay.frames.length; index += 1) {
    const frame = replay.frames[index]
    if (frame === undefined) continue
    const nextDistance = Math.abs(timestamp - frame.sourceUpdatedAt)
    if (nextDistance < distance) {
      nearest = index + 1
      distance = nextDistance
    }
  }
  return nearest
}

export const aggregateReplayChanges = (
  replay: ReplayData | null,
  cursor?: number,
): readonly LiveStationChange[] => {
  if (replay === null) return []
  const end = cursor === undefined
    ? replay.frames.length
    : Math.min(Math.max(0, cursor), replay.frames.length)
  const changes = new Map<string, LiveStationChange>()

  for (const frame of replay.frames.slice(0, end)) {
    for (const change of frame.changes) {
      const previous = changes.get(change.code)
      changes.set(change.code, {
        ...change,
        mechanicalDelta: (previous?.mechanicalDelta ?? 0) + change.mechanicalDelta,
        electricDelta: (previous?.electricDelta ?? 0) + change.electricDelta,
        docksDelta: (previous?.docksDelta ?? 0) + change.docksDelta,
      })
    }
  }
  return [...changes.values()]
}

export const stationTrend = (
  replay: ReplayData | null,
  stationCode: string,
  cursor?: number,
): StationTrend => {
  if (replay === null) return { deltas: [], points: [] }
  const end = cursor === undefined
    ? replay.frames.length
    : Math.min(Math.max(0, cursor), replay.frames.length)
  const deltas: number[] = []
  const points: number[] = [0]
  let cumulative = 0

  for (const frame of replay.frames.slice(0, end)) {
    const change = frame.changes.find((candidate) => candidate.code === stationCode)
    const delta = change === undefined
      ? 0
      : change.mechanicalDelta + change.electricDelta
    cumulative += delta
    points.push(cumulative)
    if (delta !== 0) deltas.push(delta)
  }

  return { deltas: deltas.slice(-8), points }
}

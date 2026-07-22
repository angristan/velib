import { applyLiveUpdate } from "./live-update"
import type {
  LiveData,
  LiveStationChange,
  LiveUpdate,
  ReplayBaselineStation,
  ReplayData,
  Station,
  StationTrend,
} from "./types"

const advanceReplayBaseline = (
  stations: readonly ReplayBaselineStation[],
  frame: LiveUpdate,
): readonly ReplayBaselineStation[] => {
  const states = new Map(stations.map((station) => [station.code, station]))
  for (const change of frame.changes) {
    states.set(change.code, {
      code: change.code,
      mechanical: change.mechanical,
      electric: change.electric,
      docks: change.docks,
      operative: change.operative,
    })
  }
  return [...states.values()]
}

export const appendReplayUpdate = (
  replay: ReplayData,
  update: LiveUpdate,
): ReplayData => {
  const latestSourceUpdatedAt = replay.frames.at(-1)?.sourceUpdatedAt ??
    replay.baseline.sourceUpdatedAt
  if (
    update.sourceUpdatedAt <= latestSourceUpdatedAt ||
    update.previousSourceUpdatedAt !== latestSourceUpdatedAt
  ) return replay

  const cutoff = update.sourceUpdatedAt - replay.minutes * 60_000
  const frames = [...replay.frames, update]
  let baseline = replay.baseline
  let firstRetainedFrame = 0
  while (
    firstRetainedFrame < frames.length &&
    frames[firstRetainedFrame]?.sourceUpdatedAt < cutoff
  ) {
    const frame = frames[firstRetainedFrame]
    if (frame === undefined) break
    baseline = {
      observedAt: frame.observedAt,
      sourceUpdatedAt: frame.sourceUpdatedAt,
      stations: advanceReplayBaseline(baseline.stations, frame),
    }
    firstRetainedFrame += 1
  }

  return {
    ...replay,
    from: baseline.sourceUpdatedAt,
    to: update.sourceUpdatedAt,
    baseline,
    frames: frames.slice(firstRetainedFrame),
  }
}

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

export const latestReplayUpdate = (
  replay: ReplayData | null,
): LiveUpdate | null => replay?.frames.at(-1) ?? null

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

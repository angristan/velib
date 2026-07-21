import {
  LiveStationChange,
  LiveUpdateEvent,
  SnapshotRecord
} from "./domain"

export const deriveLiveUpdate = (
  previous: SnapshotRecord,
  current: SnapshotRecord
): LiveUpdateEvent => {
  const previousStations = new Map(
    previous.snapshot.s.map((station) => [station.c, station])
  )
  const changes: Array<LiveStationChange> = []
  const currentStationCodes = new Set(current.snapshot.s.map((station) => station.c))

  for (const station of current.snapshot.s) {
    const prior = previousStations.get(station.c)
    if (prior === undefined) {
      changes.push(LiveStationChange.make({
        c: station.c,
        m: station.m,
        e: station.e,
        d: station.d,
        o: station.o === 1 ? 1 : 0,
        dm: 0,
        de: 0,
        dd: 0
      }))
      continue
    }

    const mechanicalDelta = station.m - prior.m
    const electricDelta = station.e - prior.e
    const docksDelta = station.d - prior.d
    if (
      mechanicalDelta === 0 &&
      electricDelta === 0 &&
      docksDelta === 0 &&
      station.o === prior.o
    ) {
      continue
    }

    changes.push(LiveStationChange.make({
      c: station.c,
      m: station.m,
      e: station.e,
      d: station.d,
      o: station.o === 1 ? 1 : 0,
      dm: mechanicalDelta,
      de: electricDelta,
      dd: docksDelta
    }))
  }

  for (const station of previous.snapshot.s) {
    if (currentStationCodes.has(station.c)) continue
    changes.push(LiveStationChange.make({
      c: station.c,
      m: 0,
      e: 0,
      d: 0,
      o: 0,
      dm: 0,
      de: 0,
      dd: 0
    }))
  }

  return LiveUpdateEvent.make({
    v: 1,
    observedAt: current.observedAt,
    previousSourceUpdatedAt: previous.sourceUpdatedAt,
    sourceUpdatedAt: current.sourceUpdatedAt,
    changes
  })
}

import type { LiveData, LiveUpdate } from "./types"

export const applyLiveUpdate = (
  current: LiveData,
  update: LiveUpdate
): LiveData | null => {
  if (update.previousSourceUpdatedAt !== current.sourceUpdatedAt) {
    return null
  }

  const changes = new Map(update.changes.map((change) => [change.code, change]))
  const stations = current.stations.map((station) => {
    const change = changes.get(station.code)
    if (change === undefined) {
      return station
    }

    return {
      ...station,
      mechanical: change.mechanical,
      electric: change.electric,
      docks: change.docks,
      unavailable: Math.max(
        0,
        station.capacity - change.mechanical - change.electric - change.docks
      ),
      isInstalled: change.operative,
      isRenting: change.operative,
      isReturning: change.operative
    }
  })

  return {
    observedAt: update.observedAt,
    sourceUpdatedAt: update.sourceUpdatedAt,
    stations
  }
}

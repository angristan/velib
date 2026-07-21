export type HistoryRange = "1h" | "3h" | "1d" | "7d"
export type ReplayWindowMinutes = 15 | 30 | 60
export type PlaybackSpeed = 1 | 2 | 4
export type DataMode = "live" | "replay"
export type MapMode = "stations" | "heatmap"

export type StationFilter = "all" | "bikes" | "electric" | "docks" | "attention"

export interface Coordinates {
  readonly latitude: number
  readonly longitude: number
}

export interface Station extends Coordinates {
  readonly code: string
  readonly id: string
  readonly name: string
  readonly capacity: number
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
  readonly isInstalled: boolean
  readonly isRenting: boolean
  readonly isReturning: boolean
}

export interface LiveData {
  readonly observedAt: number
  readonly sourceUpdatedAt: number
  readonly stations: readonly Station[]
}

export type LiveConnectionStatus = "connecting" | "live" | "reconnecting"

export interface LiveStationChange {
  readonly code: string
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly operative: boolean
  readonly mechanicalDelta: number
  readonly electricDelta: number
  readonly docksDelta: number
}

export interface LiveUpdate {
  readonly observedAt: number
  readonly previousSourceUpdatedAt: number
  readonly sourceUpdatedAt: number
  readonly changes: readonly LiveStationChange[]
}

export interface ReplayBaselineStation {
  readonly code: string
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly operative: boolean
}

export interface ReplayData {
  readonly minutes: ReplayWindowMinutes
  readonly generatedAt: number
  readonly from: number
  readonly to: number
  readonly baseline: {
    readonly observedAt: number
    readonly sourceUpdatedAt: number
    readonly stations: readonly ReplayBaselineStation[]
  }
  readonly frames: readonly LiveUpdate[]
}

export interface StationTrend {
  readonly deltas: readonly number[]
  readonly points: readonly number[]
}

export interface MapCamera {
  readonly latitude: number
  readonly longitude: number
  readonly zoom: number
}

export interface HistoryPoint {
  readonly at: number
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
  readonly removed: number
  readonly returned: number
}

export interface StationHistory {
  readonly stationCode: string
  readonly range: HistoryRange
  readonly points: readonly HistoryPoint[]
}

export interface UserLocation extends Coordinates {
  readonly accuracy: number
}

export const stationBikes = (station: Station): number =>
  station.mechanical + station.electric

export const stationIsOperative = (station: Station): boolean =>
  station.isInstalled && station.isRenting && station.isReturning

export const stationMatchesQuery = (station: Station, query: string): boolean => {
  const normalize = (value: string) =>
    value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim()
  const term = normalize(query)
  return term.length === 0 || normalize(`${station.name} ${station.code}`).includes(term)
}

export const stationMatchesFilter = (station: Station, filter: StationFilter): boolean => {
  if (filter === "bikes") return stationBikes(station) > 0
  if (filter === "electric") return station.electric > 0
  if (filter === "docks") return station.docks > 0
  if (filter === "attention") {
    return !stationIsOperative(station) || stationBikes(station) === 0 || station.docks === 0
  }
  return true
}

export const stationStatus = (
  station: Station,
): "unavailable" | "empty" | "full" | "balanced" => {
  if (!stationIsOperative(station)) return "unavailable"
  if (stationBikes(station) === 0) return "empty"
  if (station.docks === 0) return "full"
  return "balanced"
}

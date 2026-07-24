import type {
  DataMode,
  MapCamera,
  MapMode,
  StationFilter,
  TimelineMode,
  TimelineRange,
} from "./types"

export const DEFAULT_CAMERA: MapCamera = {
  latitude: 48.8589,
  longitude: 2.3469,
  zoom: 12.15,
}

export interface AppUrlState {
  readonly selectedCode: string | null
  readonly search: string
  readonly filter: StationFilter
  readonly mode: DataMode
  readonly replayAt: number | null
  readonly timelineMode: TimelineMode
  readonly timelineRange: TimelineRange
  readonly comparisonFromAt: number | null
  readonly mapMode: MapMode
  readonly camera: MapCamera
}

const finiteNumber = (value: string | null): number | null => {
  if (value === null || value.trim() === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseFilter = (value: string | null): StationFilter => {
  if (
    value === "bikes" ||
    value === "electric" ||
    value === "docks" ||
    value === "attention"
  ) return value
  return "all"
}

const parseTimestamp = (value: string | null): number | null => {
  if (value === null || !/^\d{9,10}$/.test(value)) return null
  const seconds = Number(value)
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null
}

const parseTimelineRange = (value: string | null): TimelineRange => {
  if (value === "6h" || value === "1d" || value === "7d") return value
  return "1h"
}

const parseCamera = (params: URLSearchParams): MapCamera => {
  const latitude = finiteNumber(params.get("lat"))
  const longitude = finiteNumber(params.get("lng"))
  const zoom = finiteNumber(params.get("z"))
  if (
    latitude === null ||
    latitude < 48.65 ||
    latitude > 49.15 ||
    longitude === null ||
    longitude < 1.85 ||
    longitude > 2.75 ||
    zoom === null ||
    zoom < 9 ||
    zoom > 19
  ) {
    return DEFAULT_CAMERA
  }
  return { latitude, longitude, zoom }
}

export const parseAppUrlState = (search: string): AppUrlState => {
  const params = new URLSearchParams(search)
  const selectedInput = params.get("station")
  const selectedCode = selectedInput !== null && /^\d{1,6}$/.test(selectedInput)
    ? selectedInput
    : null

  const mode: DataMode = params.get("mode") === "replay" ? "replay" : "live"
  const replayAt = mode === "replay" ? parseTimestamp(params.get("at")) : null
  const comparisonFromAt = mode === "replay" ? parseTimestamp(params.get("from")) : null

  return {
    selectedCode,
    search: (params.get("q") ?? "").slice(0, 80),
    filter: parseFilter(params.get("filter")),
    mode,
    replayAt,
    timelineMode: comparisonFromAt === null ? "explore" : "compare",
    timelineRange: parseTimelineRange(params.get("span")),
    comparisonFromAt,
    mapMode: params.get("layer") === "heatmap" ? "heatmap" : "stations",
    camera: parseCamera(params),
  }
}

export const clearAppUrlState = (baseUrl: string): string => {
  const url = new URL(baseUrl)
  url.search = ""
  return url.toString()
}

export const serializeAppUrlState = (
  state: AppUrlState,
  baseUrl: string,
): string => {
  const url = new URL(baseUrl)
  const params = new URLSearchParams()
  if (state.selectedCode !== null) params.set("station", state.selectedCode)
  if (state.search.trim() !== "") params.set("q", state.search.trim())
  if (state.filter !== "all") params.set("filter", state.filter)
  if (state.mode === "replay") {
    params.set("mode", "replay")
    if (state.replayAt !== null) params.set("at", String(Math.round(state.replayAt / 1_000)))
    if (state.timelineRange !== "1h") params.set("span", state.timelineRange)
    if (state.timelineMode === "compare" && state.comparisonFromAt !== null) {
      params.set("from", String(Math.round(state.comparisonFromAt / 1_000)))
    }
  }
  if (state.mapMode === "heatmap") params.set("layer", "heatmap")
  params.set("lat", state.camera.latitude.toFixed(5))
  params.set("lng", state.camera.longitude.toFixed(5))
  params.set("z", state.camera.zoom.toFixed(2))
  url.search = params.toString()
  url.hash = ""
  return url.toString()
}

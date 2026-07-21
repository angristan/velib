import type {
  DataMode,
  MapBackground,
  MapCamera,
  MapMode,
  ReplayWindowMinutes,
  StationFilter,
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
  readonly replayMinutes: ReplayWindowMinutes
  readonly replayAt: number | null
  readonly mapMode: MapMode
  readonly mapBackground: MapBackground
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

const parseReplayMinutes = (value: string | null): ReplayWindowMinutes => {
  if (value === "30") return 30
  if (value === "60") return 60
  return 15
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
  const atSeconds = finiteNumber(params.get("at"))
  const replayAt = atSeconds !== null && atSeconds > 0
    ? Math.round(atSeconds * 1_000)
    : null

  return {
    selectedCode,
    search: (params.get("q") ?? "").slice(0, 80),
    filter: parseFilter(params.get("filter")),
    mode: params.get("mode") === "replay" ? "replay" : "live",
    replayMinutes: parseReplayMinutes(params.get("window")),
    replayAt,
    mapMode: params.get("layer") === "heatmap" ? "heatmap" : "stations",
    mapBackground: params.get("basemap") === "dark" ? "dark" : "light",
    camera: parseCamera(params),
  }
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
    params.set("window", String(state.replayMinutes))
    if (state.replayAt !== null) params.set("at", String(Math.round(state.replayAt / 1_000)))
  }
  if (state.mapMode === "heatmap") params.set("layer", "heatmap")
  if (state.mapBackground === "dark") params.set("basemap", "dark")
  params.set("lat", state.camera.latitude.toFixed(5))
  params.set("lng", state.camera.longitude.toFixed(5))
  params.set("z", state.camera.zoom.toFixed(2))
  url.search = params.toString()
  url.hash = ""
  return url.toString()
}

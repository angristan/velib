import type { Coordinates } from "./types"

const compactNumber = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 })
const timeFormatter = new Intl.DateTimeFormat("fr-FR", {
  hour: "2-digit",
  minute: "2-digit",
})
const dateFormatter = new Intl.DateTimeFormat("fr-FR", {
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
})

export const formatNumber = (value: number): string => compactNumber.format(value)

export const formatTimestamp = (timestamp: number): string =>
  timestamp ? timeFormatter.format(timestamp) : "—"

export const formatChartTime = (timestamp: number, includeDay: boolean): string =>
  includeDay ? dateFormatter.format(timestamp) : timeFormatter.format(timestamp)

export const ageInMinutes = (timestamp: number, now = Date.now()): number =>
  timestamp ? Math.max(0, Math.floor((now - timestamp) / 60_000)) : 0

export const formatFreshness = (timestamp: number, now = Date.now()): string => {
  if (!timestamp) return "heure inconnue"
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000))
  if (seconds < 60) return `il y a ${seconds} s`
  const minutes = ageInMinutes(timestamp, now)
  if (minutes === 1) return "il y a 1 min"
  if (minutes < 60) return `il y a ${minutes} min`
  return `à ${formatTimestamp(timestamp)}`
}

export const formatFreshnessCompact = (timestamp: number, now = Date.now()): string => {
  if (!timestamp) return "heure inconnue"
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000))
  if (seconds < 60) return `${seconds} s`
  const minutes = ageInMinutes(timestamp, now)
  if (minutes < 60) return `${minutes} min`
  return formatTimestamp(timestamp)
}

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

export const distanceInMeters = (from: Coordinates, to: Coordinates): number => {
  const earthRadius = 6_371_000
  const latitudeDelta = toRadians(to.latitude - from.latitude)
  const longitudeDelta = toRadians(to.longitude - from.longitude)
  const fromLatitude = toRadians(from.latitude)
  const toLatitude = toRadians(to.latitude)

  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(longitudeDelta / 2) ** 2

  return 2 * earthRadius * Math.asin(Math.sqrt(haversine))
}

export const formatDistance = (meters: number): string =>
  meters < 1_000 ? `${Math.round(meters / 10) * 10} m` : `${(meters / 1_000).toFixed(1)} km`

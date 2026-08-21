import type { AppLocale } from "./locale"
import { localeTag } from "./locale"
import type { Coordinates, HistoryRange } from "./types"

const timeZone = "Europe/Paris"

const numberFormatters: Record<AppLocale, Intl.NumberFormat> = {
  fr: new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 }),
  en: new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 }),
}
const decimalFormatters: Record<AppLocale, Intl.NumberFormat> = {
  fr: new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
  en: new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
}
const distanceFormatters: Record<AppLocale, Intl.NumberFormat> = {
  fr: new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
  en: new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, minimumFractionDigits: 1 }),
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>()

const dateFormatter = (
  locale: AppLocale,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
  const key = `${locale}:${JSON.stringify(options)}`
  const cached = dateFormatters.get(key)
  if (cached !== undefined) return cached
  const formatter = new Intl.DateTimeFormat(localeTag(locale), options)
  dateFormatters.set(key, formatter)
  return formatter
}

export const formatNumber = (value: number, locale: AppLocale = "fr"): string =>
  numberFormatters[locale].format(value)

export const formatDecimal = (value: number, locale: AppLocale = "fr"): string =>
  decimalFormatters[locale].format(value)

export const formatTimestamp = (timestamp: number, locale: AppLocale = "fr"): string =>
  timestamp
    ? dateFormatter(locale, { hour: "2-digit", minute: "2-digit" }).format(timestamp)
    : "—"

export const formatChartTime = (
  timestamp: number,
  range: HistoryRange,
  locale: AppLocale = "fr",
): string => {
  if (!timestamp) return "—"
  const options: Intl.DateTimeFormatOptions = range === "1h" || range === "3h" || range === "1d"
    ? { hour: "2-digit", minute: "2-digit" }
    : range === "7d"
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", hour: "2-digit" }
  return dateFormatter(locale, { ...options, timeZone }).format(timestamp)
}

export const formatArchiveTimestamp = (timestamp: number, locale: AppLocale = "fr"): string =>
  timestamp
    ? dateFormatter(locale, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(timestamp)
    : "—"

export const formatArchiveDate = (timestamp: number, locale: AppLocale = "fr"): string =>
  timestamp
    ? dateFormatter(locale, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(timestamp)
    : "—"

export const formatArchiveClock = (timestamp: number, locale: AppLocale = "fr"): string =>
  timestamp
    ? dateFormatter(locale, { timeZone, hour: "2-digit", minute: "2-digit" }).format(timestamp)
    : "—"

export const formatArchiveTick = (
  timestamp: number,
  includeDay: boolean,
  locale: AppLocale = "fr",
): string => timestamp
  ? dateFormatter(locale, includeDay
    ? { timeZone, weekday: "short", day: "numeric" }
    : { timeZone, hour: "2-digit", minute: "2-digit" }).format(timestamp)
  : "—"

export const formatArchiveDistance = (
  timestamp: number,
  latestAt: number,
  locale: AppLocale = "fr",
): string => {
  const minutes = Math.max(0, Math.round((latestAt - timestamp) / 60_000))
  if (minutes <= 1) return locale === "fr" ? "Maintenant" : "Now"
  if (minutes < 60) return locale === "fr" ? `Il y a ${minutes} min` : `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return locale === "fr" ? `Il y a ${hours} h` : `${hours} hr ago`
  const days = Math.round(hours / 24)
  return locale === "fr" ? `Il y a ${days} j` : `${days} d ago`
}

export const formatArchiveDuration = (
  fromAt: number,
  toAt: number,
  locale: AppLocale = "fr",
): string => {
  const minutes = Math.max(0, Math.round((toAt - fromAt) / 60_000))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours < 24) {
    if (locale === "fr") return remainder === 0 ? `${hours} h` : `${hours} h ${remainder}`
    return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  if (locale === "fr") return remainingHours === 0 ? `${days} j` : `${days} j ${remainingHours} h`
  return remainingHours === 0 ? `${days} d` : `${days} d ${remainingHours} hr`
}

export const ageInMinutes = (timestamp: number, now = Date.now()): number =>
  timestamp ? Math.max(0, Math.floor((now - timestamp) / 60_000)) : 0

export const formatFreshness = (
  timestamp: number,
  now = Date.now(),
  locale: AppLocale = "fr",
): string => {
  if (!timestamp) return locale === "fr" ? "heure inconnue" : "unknown time"
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000))
  if (seconds < 60) return locale === "fr" ? `il y a ${seconds} s` : `${seconds} sec ago`
  const minutes = ageInMinutes(timestamp, now)
  if (minutes < 60) return locale === "fr" ? `il y a ${minutes} min` : `${minutes} min ago`
  return locale === "fr"
    ? `à ${formatTimestamp(timestamp, locale)}`
    : `at ${formatTimestamp(timestamp, locale)}`
}

export const formatFreshnessCompact = (
  timestamp: number,
  now = Date.now(),
  locale: AppLocale = "fr",
): string => {
  if (!timestamp) return locale === "fr" ? "heure inconnue" : "unknown time"
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000))
  if (seconds < 60) return `${seconds} s`
  const minutes = ageInMinutes(timestamp, now)
  if (minutes < 60) return `${minutes} min`
  return formatTimestamp(timestamp, locale)
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

export const formatDistance = (meters: number, locale: AppLocale = "fr"): string =>
  meters < 1_000
    ? `${Math.round(meters / 10) * 10} m`
    : `${distanceFormatters[locale].format(meters / 1_000)} km`

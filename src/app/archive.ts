import type {
  LiveData,
  LiveStationChange,
  TimelineRange,
} from "./types"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export const ARCHIVE_RETENTION_MS = 7 * DAY_MS
export const ARCHIVE_SCALE_MAX = 10_000

const archiveScaleDenominator = Math.log1p(ARCHIVE_RETENTION_MS / MINUTE_MS)

export const archiveScalePosition = (timestamp: number, latestAt: number): number => {
  const age = Math.min(ARCHIVE_RETENTION_MS, Math.max(0, latestAt - timestamp))
  const elapsedShare = Math.log1p(age / MINUTE_MS) / archiveScaleDenominator
  return Math.round(ARCHIVE_SCALE_MAX * (1 - elapsedShare))
}

export const archiveTimestampAtScale = (position: number, latestAt: number): number => {
  const boundedPosition = Math.min(ARCHIVE_SCALE_MAX, Math.max(0, position))
  const elapsedShare = 1 - boundedPosition / ARCHIVE_SCALE_MAX
  const ageMinutes = Math.expm1(elapsedShare * archiveScaleDenominator)
  const age = Math.min(ARCHIVE_RETENTION_MS, Math.round(ageMinutes) * MINUTE_MS)
  return latestAt - age
}

export const archiveScaleLandmarks = (
  latestAt: number,
  labels: { readonly dayShort: string; readonly now: string } = {
    dayShort: "j",
    now: "Maintenant",
  },
): ReadonlyArray<{
  readonly label: string
  readonly position: number
  readonly timestamp: number
}> => [
  { label: `−7 ${labels.dayShort}`, timestamp: latestAt - ARCHIVE_RETENTION_MS },
  { label: `−3 ${labels.dayShort}`, timestamp: latestAt - 3 * DAY_MS },
  { label: "−24 h", timestamp: latestAt - DAY_MS },
  { label: "−6 h", timestamp: latestAt - 6 * HOUR_MS },
  { label: "−1 h", timestamp: latestAt - HOUR_MS },
  { label: "−15 min", timestamp: latestAt - 15 * MINUTE_MS },
  { label: labels.now, timestamp: latestAt },
].map((landmark) => ({
  ...landmark,
  position: archiveScalePosition(landmark.timestamp, latestAt),
}))

export const timelineRanges: ReadonlyArray<{
  readonly value: TimelineRange
  readonly durationMs: number
}> = [
  { value: "1h", durationMs: HOUR_MS },
  { value: "6h", durationMs: 6 * HOUR_MS },
  { value: "1d", durationMs: DAY_MS },
  { value: "7d", durationMs: ARCHIVE_RETENTION_MS },
]

export const timelineDuration = (range: TimelineRange): number =>
  timelineRanges.find((candidate) => candidate.value === range)?.durationMs ?? HOUR_MS

export const timelineBounds = (
  latestAt: number,
  range: TimelineRange,
): { readonly min: number; readonly max: number; readonly step: number } => {
  const duration = timelineDuration(range)
  return {
    min: latestAt - duration,
    max: latestAt,
    step: duration <= HOUR_MS ? MINUTE_MS : 5 * MINUTE_MS,
  }
}

export const timelineTicks = (
  min: number,
  max: number,
  count = 5,
): readonly number[] => {
  if (count <= 1 || max <= min) return [min]
  return Array.from({ length: count }, (_, index) =>
    min + ((max - min) * index) / (count - 1)
  )
}

export const clampTimelineAt = (
  timestamp: number,
  latestAt: number,
  range: TimelineRange,
): number => {
  const bounds = timelineBounds(latestAt, range)
  return Math.min(bounds.max, Math.max(bounds.min, timestamp))
}

export const defaultComparison = (
  selectedAt: number,
  latestAt: number,
  range: TimelineRange,
): readonly [number, number] => {
  const to = clampTimelineAt(selectedAt, latestAt, range)
  const bounds = timelineBounds(latestAt, range)
  const interval = Math.min(HOUR_MS, Math.max(15 * MINUTE_MS, timelineDuration(range) / 4))
  return [Math.max(bounds.min, to - interval), to]
}

export const compareSnapshots = (
  from: LiveData | null,
  to: LiveData | null,
): readonly LiveStationChange[] => {
  if (from === null || to === null) return []
  const fromByCode = new Map(from.stations.map((station) => [station.code, station]))

  return to.stations.flatMap((station) => {
    const previous = fromByCode.get(station.code)
    if (previous === undefined) return []
    const operative = station.isInstalled && station.isRenting && station.isReturning
    const previousOperative = previous.isInstalled && previous.isRenting && previous.isReturning
    const docksDelta = station.docks - previous.docks
    const electricDelta = station.electric - previous.electric
    const mechanicalDelta = station.mechanical - previous.mechanical
    if (
      docksDelta === 0 &&
      electricDelta === 0 &&
      mechanicalDelta === 0 &&
      operative === previousOperative
    ) return []

    return [{
      code: station.code,
      docks: station.docks,
      docksDelta,
      electric: station.electric,
      electricDelta,
      mechanical: station.mechanical,
      mechanicalDelta,
      operative,
    }]
  })
}

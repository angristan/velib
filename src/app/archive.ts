import type {
  LiveData,
  LiveStationChange,
  TimelineRange,
} from "./types"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

export const ARCHIVE_RETENTION_MS = 7 * DAY_MS

export const timelineRanges: ReadonlyArray<{
  readonly value: TimelineRange
  readonly label: string
  readonly durationMs: number
}> = [
  { value: "1h", label: "1 h", durationMs: HOUR_MS },
  { value: "6h", label: "6 h", durationMs: 6 * HOUR_MS },
  { value: "1d", label: "24 h", durationMs: DAY_MS },
  { value: "7d", label: "7 j", durationMs: ARCHIVE_RETENTION_MS },
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

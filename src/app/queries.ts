import { queryOptions, skipToken } from "@tanstack/react-query"

import { fetchReplayData, fetchStationHistory } from "./api"
import { mergeReplayRefresh } from "./replay"
import type {
  HistoryRange,
  LiveData,
  ReplayData,
  ReplayWindowMinutes,
} from "./types"

const MINUTE_MS = 60_000

export const velibQueryKeys = {
  all: ["velib"] as const,
  live: () => [...velibQueryKeys.all, "live"] as const,
  histories: () => [...velibQueryKeys.all, "station-history"] as const,
  history: (stationCode: string | null, range: HistoryRange) =>
    [...velibQueryKeys.histories(), stationCode, range] as const,
  replays: () => [...velibQueryKeys.all, "replay"] as const,
  replay: (minutes: ReplayWindowMinutes, anchorAt: number | null) =>
    [...velibQueryKeys.replays(), minutes, anchorAt] as const,
}

const isLiveData = (value: unknown): value is LiveData =>
  typeof value === "object" &&
  value !== null &&
  typeof Reflect.get(value, "sourceUpdatedAt") === "number" &&
  Array.isArray(Reflect.get(value, "stations"))

const shareLiveData = (previous: unknown, refreshed: unknown): unknown => {
  if (refreshed !== null && !isLiveData(refreshed)) return refreshed
  if (!isLiveData(previous)) return refreshed
  if (refreshed === null || refreshed.sourceUpdatedAt < previous.sourceUpdatedAt) {
    return previous
  }
  return refreshed
}

const isReplayData = (value: unknown): value is ReplayData =>
  typeof value === "object" &&
  value !== null &&
  Array.isArray(Reflect.get(value, "frames")) &&
  typeof Reflect.get(value, "baseline") === "object"

const shareReplayData = (previous: unknown, refreshed: unknown): unknown => {
  if (refreshed !== null && !isReplayData(refreshed)) return refreshed
  const previousReplay = previous === null || isReplayData(previous) ? previous : undefined
  return mergeReplayRefresh(previousReplay, refreshed)
}

export const liveQueryOptions = (
  load: (signal: AbortSignal) => Promise<LiveData | null>,
) => queryOptions({
  gcTime: 10 * MINUTE_MS,
  queryFn: ({ signal }) => load(signal),
  queryKey: velibQueryKeys.live(),
  refetchOnWindowFocus: false,
  staleTime: 5 * MINUTE_MS,
  structuralSharing: shareLiveData,
})

export const replayQueryOptions = (
  minutes: ReplayWindowMinutes,
  anchorAt: number | null,
) => queryOptions({
  gcTime: 10 * MINUTE_MS,
  queryFn: ({ signal }) => fetchReplayData(minutes, anchorAt, signal),
  queryKey: velibQueryKeys.replay(minutes, anchorAt),
  refetchOnWindowFocus: false,
  staleTime: MINUTE_MS,
  structuralSharing: shareReplayData,
})

export const stationHistoryQueryOptions = (
  stationCode: string | null,
  range: HistoryRange,
) => queryOptions({
  gcTime: 10 * MINUTE_MS,
  queryFn: stationCode === null
    ? skipToken
    : ({ signal }) => fetchStationHistory(stationCode, range, signal),
  queryKey: velibQueryKeys.history(stationCode, range),
  staleTime: 30_000,
})

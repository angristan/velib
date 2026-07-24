import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  ApiRequestError,
  decodeLiveUpdate,
  fetchLiveData,
} from "../api"
import { applyLiveUpdate } from "../live-update"
import {
  archiveSnapshotQueryOptions,
  liveQueryOptions,
  replayQueryOptions,
  stationHistoryQueryOptions,
  velibQueryKeys,
} from "../queries"
import { appendReplayUpdate } from "../replay"
import type {
  ArchiveSnapshot,
  HistoryRange,
  LiveConnectionStatus,
  LiveData,
  LiveUpdate,
  ReplayData,
  ReplayWindowMinutes,
  StationHistory,
} from "../types"

interface QueryState<T> {
  readonly data: T
  readonly loading: boolean
  readonly error: string | null
}

const FALLBACK_POLL_MS = 60_000
const LIVE_RECONCILE_MS = 5 * 60_000
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000, 5 * 60_000]

const messageFrom = (error: unknown): string =>
  error instanceof Error ? error.message : "Une erreur inattendue est survenue"

export const useLiveData = (
  enabled: boolean,
  onUnauthorized: () => void,
): QueryState<LiveData | null> & {
  readonly connection: LiveConnectionStatus
  readonly liveUpdate: LiveUpdate | null
  readonly refresh: () => void
} => {
  const queryClient = useQueryClient()
  const [connection, setConnection] = useState<LiveConnectionStatus>("connecting")
  const [liveUpdate, setLiveUpdate] = useState<LiveUpdate | null>(null)
  const socketOpenRef = useRef(false)
  const reconcileKeyRef = useRef<number | null | undefined>(undefined)
  const lastLoadedAtRef = useRef(0)

  const loadSnapshot = useCallback(async (signal: AbortSignal) => {
    const reconcileKey = reconcileKeyRef.current
    reconcileKeyRef.current = null
    const current = queryClient.getQueryData<LiveData | null>(velibQueryKeys.live())
    const nextData = reconcileKey === undefined
      ? await fetchLiveData(signal)
      : await fetchLiveData(signal, reconcileKey)
    if (
      current !== undefined &&
      current !== null &&
      nextData !== null &&
      nextData.sourceUpdatedAt > current.sourceUpdatedAt
    ) {
      setLiveUpdate(null)
    }
    lastLoadedAtRef.current = Date.now()
    return nextData
  }, [queryClient])
  const options = useMemo(() => liveQueryOptions(loadSnapshot), [loadSnapshot])
  const query = useQuery({ ...options, enabled })

  const refetch = useCallback(() => {
    void queryClient.refetchQueries({
      exact: true,
      queryKey: options.queryKey,
      type: "active",
    })
  }, [options.queryKey, queryClient])

  const refresh = useCallback(() => {
    reconcileKeyRef.current = Math.floor(Date.now() / 60_000) * 60_000
    refetch()
  }, [refetch])

  useEffect(() => {
    if (query.error instanceof ApiRequestError && query.error.status === 401) {
      onUnauthorized()
    }
  }, [onUnauthorized, query.error])

  useEffect(() => {
    if (!enabled) return
    const reconcileWhenNeeded = () => {
      if (document.visibilityState !== "visible") return
      const interval = socketOpenRef.current ? LIVE_RECONCILE_MS : FALLBACK_POLL_MS
      if (Date.now() - lastLoadedAtRef.current >= interval) refetch()
    }

    const interval = window.setInterval(reconcileWhenNeeded, FALLBACK_POLL_MS)
    document.addEventListener("visibilitychange", reconcileWhenNeeded)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", reconcileWhenNeeded)
    }
  }, [enabled, refetch])

  useEffect(() => {
    if (!enabled) {
      socketOpenRef.current = false
      setConnection("connecting")
      return
    }
    let stopped = false
    let socket: WebSocket | null = null
    let reconnectTimer: number | undefined
    let stableTimer: number | undefined
    let attempt = 0

    const scheduleReconnect = () => {
      if (stopped) return
      socketOpenRef.current = false
      setConnection("reconnecting")
      const baseDelay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 300_000
      const delay = Math.round(baseDelay * (0.8 + Math.random() * 0.4))
      attempt += 1
      reconnectTimer = window.setTimeout(connect, delay)
    }

    const connect = () => {
      if (stopped) return
      if (attempt === 0) setConnection("connecting")

      const url = new URL("/api/live/socket", window.location.href)
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
      const nextSocket = new WebSocket(url)
      socket = nextSocket

      nextSocket.onopen = () => {
        const reconnected = attempt > 0
        socketOpenRef.current = true
        setConnection("live")
        if (reconnected) {
          reconcileKeyRef.current = Math.floor(Date.now() / 60_000) * 60_000
          refetch()
        }
        stableTimer = window.setTimeout(() => {
          attempt = 0
        }, 30_000)
      }

      nextSocket.onmessage = (event) => {
        if (typeof event.data !== "string") return
        let input: unknown
        try {
          input = JSON.parse(event.data)
        } catch {
          return
        }

        const update = decodeLiveUpdate(input)
        if (update === null) return
        const current = queryClient.getQueryData<LiveData | null>(options.queryKey) ?? null
        if (current === null) {
          reconcileKeyRef.current = update.sourceUpdatedAt
          refetch()
          return
        }
        if (update.sourceUpdatedAt <= current.sourceUpdatedAt) return

        const nextData = applyLiveUpdate(current, update)
        if (nextData === null) {
          setLiveUpdate(null)
          reconcileKeyRef.current = update.sourceUpdatedAt
          refetch()
          return
        }

        queryClient.setQueryData(options.queryKey, nextData)
        setLiveUpdate(update)
      }

      nextSocket.onerror = () => {
        nextSocket.close()
      }
      nextSocket.onclose = () => {
        if (stableTimer !== undefined) window.clearTimeout(stableTimer)
        scheduleReconnect()
      }
    }

    connect()

    return () => {
      stopped = true
      socketOpenRef.current = false
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer)
      if (stableTimer !== undefined) window.clearTimeout(stableTimer)
      socket?.close()
    }
  }, [enabled, options.queryKey, queryClient, refetch])

  return {
    data: query.data ?? null,
    loading: enabled && query.isPending,
    error: query.error === null ? null : messageFrom(query.error),
    connection,
    liveUpdate,
    refresh,
  }
}

export const useArchiveSnapshot = (
  anchorAt: number | null,
  enabled: boolean,
  onUnauthorized: () => void,
): QueryState<ArchiveSnapshot | null> => {
  const options = useMemo(() => archiveSnapshotQueryOptions(anchorAt), [anchorAt])
  const query = useQuery({ ...options, enabled: enabled && anchorAt !== null })

  useEffect(() => {
    if (query.error instanceof ApiRequestError && query.error.status === 401) {
      onUnauthorized()
    }
  }, [onUnauthorized, query.error])

  return {
    data: query.data ?? null,
    loading: enabled && anchorAt !== null && query.isFetching,
    error: query.error === null ? null : messageFrom(query.error),
  }
}

export const useReplayData = (
  minutes: ReplayWindowMinutes,
  refreshKey: number,
  anchorAt: number | null,
  liveUpdate: LiveUpdate | null,
  enabled: boolean,
  onUnauthorized: () => void,
): QueryState<ReplayData | null> => {
  const queryClient = useQueryClient()
  const options = useMemo(
    () => replayQueryOptions(minutes, anchorAt),
    [anchorAt, minutes],
  )
  const query = useQuery({ ...options, enabled })
  const previousRefreshKeyRef = useRef(refreshKey)

  useEffect(() => {
    if (previousRefreshKeyRef.current === refreshKey) return
    previousRefreshKeyRef.current = refreshKey
    if (enabled) {
      void queryClient.invalidateQueries({ exact: true, queryKey: options.queryKey })
    }
  }, [enabled, options.queryKey, queryClient, refreshKey])

  useEffect(() => {
    if (liveUpdate === null || anchorAt !== null) return
    queryClient.setQueryData<ReplayData | null>(options.queryKey, (current) =>
      current === undefined || current === null
        ? current
        : appendReplayUpdate(current, liveUpdate)
    )
  }, [anchorAt, liveUpdate, options.queryKey, queryClient])

  useEffect(() => {
    if (query.error instanceof ApiRequestError && query.error.status === 401) {
      onUnauthorized()
    }
  }, [onUnauthorized, query.error])

  return {
    data: query.data ?? null,
    loading: enabled && query.isPending,
    error: query.error === null ? null : messageFrom(query.error),
  }
}

export const useStationHistory = (
  stationCode: string | null,
  range: HistoryRange,
  enabled: boolean,
  onUnauthorized: () => void,
): QueryState<StationHistory | null> => {
  const options = useMemo(
    () => stationHistoryQueryOptions(stationCode, range),
    [range, stationCode],
  )
  const query = useQuery({
    ...options,
    enabled: enabled && stationCode !== null,
  })

  useEffect(() => {
    if (query.error instanceof ApiRequestError && query.error.status === 401) {
      onUnauthorized()
    }
  }, [onUnauthorized, query.error])

  return {
    data: query.data ?? null,
    loading: enabled && stationCode !== null && query.isPending,
    error: query.error === null ? null : messageFrom(query.error),
  }
}

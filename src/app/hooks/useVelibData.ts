import { useCallback, useEffect, useRef, useState } from "react"
import {
  decodeLiveUpdate,
  fetchLiveData,
  fetchReplayData,
  fetchStationHistory,
} from "../api"
import { applyLiveUpdate } from "../live-update"
import { appendReplayUpdate } from "../replay"
import type {
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

export const useLiveData = (): QueryState<LiveData | null> & {
  readonly connection: LiveConnectionStatus
  readonly liveUpdate: LiveUpdate | null
  readonly refresh: () => void
} => {
  const [data, setData] = useState<LiveData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [connection, setConnection] = useState<LiveConnectionStatus>("connecting")
  const [liveUpdate, setLiveUpdate] = useState<LiveUpdate | null>(null)
  const [requestNumber, setRequestNumber] = useState(0)
  const dataRef = useRef<LiveData | null>(null)
  const socketOpenRef = useRef(false)
  const reconcileKeyRef = useRef<number | null>(null)

  const refresh = useCallback(() => {
    reconcileKeyRef.current = Math.floor(Date.now() / 60_000) * 60_000
    setRequestNumber((current) => current + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    let inFlight = false
    let lastLoadedAt = 0
    setLoading(true)

    const load = async () => {
      if (inFlight) return
      inFlight = true
      try {
        const reconcileKey = reconcileKeyRef.current
        reconcileKeyRef.current = null
        const nextData = await fetchLiveData(controller.signal, reconcileKey)
        const current = dataRef.current
        if (
          nextData !== null &&
          (current === null || nextData.sourceUpdatedAt >= current.sourceUpdatedAt)
        ) {
          if (current !== null && nextData.sourceUpdatedAt > current.sourceUpdatedAt) {
            setLiveUpdate(null)
          }
          dataRef.current = nextData
          setData(nextData)
        } else if (nextData === null && current === null) {
          setData(null)
        }
        lastLoadedAt = Date.now()
        setError(null)
      } catch (nextError) {
        if (!controller.signal.aborted) setError(messageFrom(nextError))
      } finally {
        inFlight = false
        if (!controller.signal.aborted) setLoading(false)
      }
    }

    const reconcileWhenNeeded = () => {
      if (document.visibilityState !== "visible") return
      const interval = socketOpenRef.current ? LIVE_RECONCILE_MS : FALLBACK_POLL_MS
      if (Date.now() - lastLoadedAt >= interval) {
        void load()
      }
    }

    void load()
    const interval = window.setInterval(reconcileWhenNeeded, FALLBACK_POLL_MS)
    document.addEventListener("visibilitychange", reconcileWhenNeeded)

    return () => {
      controller.abort()
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", reconcileWhenNeeded)
    }
  }, [requestNumber])

  useEffect(() => {
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
          setRequestNumber((value) => value + 1)
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
        const current = dataRef.current
        if (current === null) {
          reconcileKeyRef.current = update.sourceUpdatedAt
          setRequestNumber((value) => value + 1)
          return
        }
        if (update.sourceUpdatedAt <= current.sourceUpdatedAt) return

        const nextData = applyLiveUpdate(current, update)
        if (nextData === null) {
          setLiveUpdate(null)
          reconcileKeyRef.current = update.sourceUpdatedAt
          setRequestNumber((value) => value + 1)
          return
        }

        dataRef.current = nextData
        setData(nextData)
        setLiveUpdate(update)
        setError(null)
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
  }, [])

  return { data, loading, error, connection, liveUpdate, refresh }
}

export const useReplayData = (
  minutes: ReplayWindowMinutes,
  refreshKey: number,
  anchorAt: number | null,
  liveUpdate: LiveUpdate | null,
): QueryState<ReplayData | null> => {
  const [data, setData] = useState<ReplayData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const parametersRef = useRef({ minutes, anchorAt })
  const liveUpdateRef = useRef(liveUpdate)
  liveUpdateRef.current = liveUpdate

  useEffect(() => {
    const controller = new AbortController()
    const parametersChanged = parametersRef.current.minutes !== minutes ||
      parametersRef.current.anchorAt !== anchorAt
    parametersRef.current = { minutes, anchorAt }
    if (parametersChanged) setData(null)
    setLoading(true)
    setError(null)

    fetchReplayData(minutes, anchorAt, controller.signal)
      .then((replay) => {
        const latestUpdate = liveUpdateRef.current
        setData(
          replay === null || latestUpdate === null
            ? replay
            : appendReplayUpdate(replay, latestUpdate),
        )
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(messageFrom(nextError))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [anchorAt, minutes, refreshKey])

  useEffect(() => {
    if (liveUpdate === null) return
    setData((current) => current === null
      ? null
      : appendReplayUpdate(current, liveUpdate))
  }, [liveUpdate])

  return { data, loading, error }
}

export const useStationHistory = (
  stationCode: string | null,
  range: HistoryRange,
): QueryState<StationHistory | null> => {
  const [data, setData] = useState<StationHistory | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!stationCode) {
      setData(null)
      setError(null)
      return
    }

    const controller = new AbortController()
    setLoading(true)
    setError(null)

    fetchStationHistory(stationCode, range, controller.signal)
      .then((history) => {
        setData(history)
      })
      .catch((nextError: unknown) => {
        if (!controller.signal.aborted) setError(messageFrom(nextError))
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })

    return () => controller.abort()
  }, [stationCode, range])

  return { data, loading, error }
}

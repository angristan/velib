import type {
  HistoryPoint,
  HistoryRange,
  LiveData,
  LiveStationChange,
  LiveUpdate,
  ReplayData,
  ReplayWindowMinutes,
  Station,
  StationHistory,
} from "./types"

const toRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined
  }

  return Object.fromEntries(Object.entries(value))
}

const first = (
  record: Record<string, unknown>,
  keys: readonly string[],
): unknown => {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key]
  }
  return undefined
}

const numberFrom = (value: unknown, fallback = 0): number => {
  const parsed = typeof value === "number" ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const requiredInteger = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined

const integerFrom = (value: unknown, fallback = 0): number =>
  Math.max(0, Math.round(numberFrom(value, fallback)))

const stringFrom = (value: unknown, fallback = ""): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : fallback

const booleanFrom = (value: unknown, fallback = true): boolean => {
  if (typeof value === "boolean") return value
  if (value === 0 || value === "0" || value === "false") return false
  if (value === 1 || value === "1" || value === "true") return true
  return fallback
}

const timestampFrom = (value: unknown): number => {
  if (typeof value === "string" && !/^\d+(\.\d+)?$/.test(value)) {
    const parsedDate = Date.parse(value)
    return Number.isFinite(parsedDate) ? parsedDate : 0
  }

  const parsed = numberFrom(value)
  return parsed > 0 && parsed < 10_000_000_000 ? parsed * 1_000 : parsed
}

const arrayFrom = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : []

const normalizeStation = (value: unknown): Station | undefined => {
  const station = toRecord(value)
  if (!station) return undefined

  const code = stringFrom(first(station, ["code", "stationCode", "station_code"]))
  const name = stringFrom(first(station, ["name", "stationName", "station_name"]))
  const latitude = numberFrom(first(station, ["latitude", "lat"]))
  const longitude = numberFrom(first(station, ["longitude", "lon", "lng"]))

  if (!code || !name || !latitude || !longitude) return undefined

  const operative = booleanFrom(first(station, ["operative"]))

  return {
    code,
    id: stringFrom(first(station, ["id", "stationId", "station_id"]), code),
    name,
    latitude,
    longitude,
    capacity: integerFrom(first(station, ["capacity", "totalCapacity", "total_capacity"])),
    mechanical: integerFrom(
      first(station, ["mechanical", "mechanicalBikes", "mechanical_bikes"]),
    ),
    electric: integerFrom(first(station, ["electric", "electricBikes", "electric_bikes"])),
    docks: integerFrom(first(station, ["docks", "docksAvailable", "docks_available"])),
    unavailable: integerFrom(
      first(station, ["unavailable", "unavailableDocks", "unavailable_docks"]),
    ),
    isInstalled: operative && booleanFrom(first(station, ["isInstalled", "is_installed"])),
    isRenting: operative && booleanFrom(first(station, ["isRenting", "is_renting"])),
    isReturning: operative && booleanFrom(first(station, ["isReturning", "is_returning"])),
  }
}

export const decodeLiveData = (value: unknown): LiveData | null => {
  const outer = toRecord(value)
  if (!outer) return null

  const nested = toRecord(outer.data)
  const payload = nested ?? outer
  const stationValues = arrayFrom(first(payload, ["stations", "items", "status"]))
  const stations = stationValues
    .map(normalizeStation)
    .filter((station): station is Station => station !== undefined)

  const observedAt = timestampFrom(
    first(payload, ["observedAt", "observed_at", "collectedAt", "collected_at"]),
  )
  const sourceUpdatedAt = timestampFrom(
    first(payload, ["sourceUpdatedAt", "source_updated_at", "lastUpdated", "last_updated"]),
  )

  if (stations.length === 0 && !observedAt) return null

  return {
    observedAt,
    sourceUpdatedAt: sourceUpdatedAt || observedAt,
    stations,
  }
}

export const decodeLiveUpdate = (value: unknown): LiveUpdate | null => {
  const payload = toRecord(value)
  if (!payload || payload.v !== 1) return null

  const observedInput = requiredInteger(payload.observedAt)
  const previousSourceInput = requiredInteger(payload.previousSourceUpdatedAt)
  const sourceInput = requiredInteger(payload.sourceUpdatedAt)
  if (
    observedInput === undefined ||
    observedInput <= 0 ||
    previousSourceInput === undefined ||
    previousSourceInput <= 0 ||
    sourceInput === undefined ||
    sourceInput <= previousSourceInput
  ) {
    return null
  }
  const observedAt = timestampFrom(observedInput)
  const previousSourceUpdatedAt = timestampFrom(previousSourceInput)
  const sourceUpdatedAt = timestampFrom(sourceInput)

  const inputChanges = arrayFrom(payload.changes)
  const changes: Array<LiveStationChange> = []
  for (const input of inputChanges) {
    const change = toRecord(input)
    if (!change) return null

    const stationCode = requiredInteger(change.c)
    const mechanical = requiredInteger(change.m)
    const electric = requiredInteger(change.e)
    const docks = requiredInteger(change.d)
    const operative = requiredInteger(change.o)
    const mechanicalDelta = requiredInteger(change.dm)
    const electricDelta = requiredInteger(change.de)
    const docksDelta = requiredInteger(change.dd)
    if (
      stationCode === undefined ||
      stationCode <= 0 ||
      mechanical === undefined ||
      mechanical < 0 ||
      mechanical > 10_000 ||
      electric === undefined ||
      electric < 0 ||
      electric > 10_000 ||
      docks === undefined ||
      docks < 0 ||
      docks > 10_000 ||
      (operative !== 0 && operative !== 1) ||
      mechanicalDelta === undefined ||
      Math.abs(mechanicalDelta) > 10_000 ||
      electricDelta === undefined ||
      Math.abs(electricDelta) > 10_000 ||
      docksDelta === undefined ||
      Math.abs(docksDelta) > 10_000
    ) {
      return null
    }

    changes.push({
      code: String(stationCode),
      mechanical,
      electric,
      docks,
      operative: operative === 1,
      mechanicalDelta,
      electricDelta,
      docksDelta,
    })
  }

  return {
    observedAt,
    previousSourceUpdatedAt,
    sourceUpdatedAt,
    changes,
  }
}

export const decodeReplayData = (value: unknown): ReplayData | null => {
  const payload = toRecord(value)
  if (!payload || payload.v !== 1) return null

  const minutesInput = requiredInteger(payload.minutes)
  if (minutesInput !== 15 && minutesInput !== 30 && minutesInput !== 60) return null
  const minutes: ReplayWindowMinutes = minutesInput
  const generatedAt = timestampFrom(payload.generatedAt)
  const from = timestampFrom(payload.from)
  const to = timestampFrom(payload.to)
  const baselineInput = toRecord(payload.baseline)
  if (!generatedAt || !from || !to || from > to || !baselineInput) return null

  const baselineObservedAt = timestampFrom(baselineInput.observedAt)
  const baselineSourceUpdatedAt = timestampFrom(baselineInput.sourceUpdatedAt)
  if (!baselineObservedAt || !baselineSourceUpdatedAt) return null

  const stations = []
  for (const input of arrayFrom(baselineInput.stations)) {
    const station = toRecord(input)
    if (!station) return null
    const code = requiredInteger(station.c)
    const mechanical = requiredInteger(station.m)
    const electric = requiredInteger(station.e)
    const docks = requiredInteger(station.d)
    const operative = requiredInteger(station.o)
    if (
      code === undefined ||
      code <= 0 ||
      mechanical === undefined ||
      mechanical < 0 ||
      mechanical > 10_000 ||
      electric === undefined ||
      electric < 0 ||
      electric > 10_000 ||
      docks === undefined ||
      docks < 0 ||
      docks > 10_000 ||
      (operative !== 0 && operative !== 1)
    ) {
      return null
    }
    stations.push({
      code: String(code),
      mechanical,
      electric,
      docks,
      operative: operative === 1,
    })
  }
  if (stations.length === 0) return null

  const frames: LiveUpdate[] = []
  let expectedSourceUpdatedAt = baselineSourceUpdatedAt
  for (const input of arrayFrom(payload.frames)) {
    const frame = decodeLiveUpdate(input)
    if (frame === null || frame.previousSourceUpdatedAt !== expectedSourceUpdatedAt) {
      return null
    }
    frames.push(frame)
    expectedSourceUpdatedAt = frame.sourceUpdatedAt
  }

  return {
    minutes,
    generatedAt,
    from,
    to,
    baseline: {
      observedAt: baselineObservedAt,
      sourceUpdatedAt: baselineSourceUpdatedAt,
      stations,
    },
    frames,
  }
}

const historyMetric = (value: unknown): number => {
  const aggregate = toRecord(value)
  return aggregate ? numberFrom(first(aggregate, ["avg", "average"])) : numberFrom(value)
}

const normalizeHistoryPoint = (value: unknown): HistoryPoint | undefined => {
  const point = toRecord(value)
  if (!point) return undefined

  const at = timestampFrom(first(point, ["at", "bucketAt", "bucket_at", "observedAt", "observed_at"]))
  if (!at) return undefined

  const removedMechanical = integerFrom(
    first(point, ["mechanicalRemoved", "mechanical_removed"]),
  )
  const removedElectric = integerFrom(first(point, ["electricRemoved", "electric_removed"]))
  const returnedMechanical = integerFrom(
    first(point, ["mechanicalReturned", "mechanical_returned"]),
  )
  const returnedElectric = integerFrom(first(point, ["electricReturned", "electric_returned"]))

  return {
    at,
    mechanical: historyMetric(
      first(point, ["mechanical", "mechanicalAvg", "mechanical_avg"]),
    ),
    electric: historyMetric(first(point, ["electric", "electricAvg", "electric_avg"])),
    docks: historyMetric(first(point, ["docks", "docksAvg", "docks_avg"])),
    unavailable: historyMetric(
      first(point, ["unavailable", "unavailableAvg", "unavailable_avg"]),
    ),
    removed: integerFrom(first(point, ["removed", "bikesRemoved", "bikes_removed"])) +
      removedMechanical +
      removedElectric,
    returned: integerFrom(first(point, ["returned", "bikesReturned", "bikes_returned"])) +
      returnedMechanical +
      returnedElectric,
  }
}

export const decodeStationHistory = (
  value: unknown,
  stationCode: string,
  range: HistoryRange,
): StationHistory => {
  const outer = toRecord(value)
  const nestedValue = outer?.data
  const nested = toRecord(nestedValue)
  const payload = nested ?? outer
  const directPoints = Array.isArray(nestedValue) ? nestedValue : undefined
  const pointValues = directPoints ?? arrayFrom(first(payload ?? {}, ["points", "history", "items"]))
  const points = pointValues
    .map(normalizeHistoryPoint)
    .filter((point): point is HistoryPoint => point !== undefined)
    .sort((left, right) => left.at - right.at)

  return { stationCode, range, points }
}

export interface SessionStatus {
  readonly verified: boolean
  readonly turnstileSiteKey: string
}

export class ApiRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = "ApiRequestError"
    this.status = status
  }
}

const errorMessage = async (response: Response): Promise<string> => {
  const fallback = `La requête a échoué (${response.status})`
  try {
    const body: unknown = await response.json()
    const record = toRecord(body)
    const nestedError = toRecord(record?.error)
    return stringFrom(
      nestedError ? first(nestedError, ["message", "detail"]) : record?.message,
      fallback,
    )
  } catch {
    return fallback
  }
}

export const fetchLiveData = async (
  signal: AbortSignal,
  reconcileKey: number | null = Math.floor(Date.now() / 60_000) * 60_000,
): Promise<LiveData | null> => {
  const path = reconcileKey === null
    ? "/api/live"
    : `/api/live?reconcile=${encodeURIComponent(reconcileKey)}`
  const response = await fetch(path, {
    cache: reconcileKey === null ? "default" : "no-store",
    headers: { Accept: "application/json" },
    signal,
  })

  if (response.status === 204 || response.status === 404) return null
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorMessage(response))
  }

  const body: unknown = await response.json()
  return decodeLiveData(body)
}

export const fetchReplayData = async (
  minutes: ReplayWindowMinutes,
  anchorAt: number | null,
  signal: AbortSignal,
): Promise<ReplayData | null> => {
  const at = anchorAt === null ? "" : `&at=${Math.round(anchorAt / 1_000)}`
  const response = await fetch(`/api/replay?minutes=${minutes}${at}`, {
    headers: { Accept: "application/json" },
    signal,
  })

  if (response.status === 204 || response.status === 404) return null
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorMessage(response))
  }

  const body: unknown = await response.json()
  const replay = decodeReplayData(body)
  if (replay === null) throw new Error("La relecture reçue est invalide")
  return replay
}

export const fetchStationHistory = async (
  stationCode: string,
  range: HistoryRange,
  signal: AbortSignal,
): Promise<StationHistory> => {
  const path = `/api/stations/${encodeURIComponent(stationCode)}/history?range=${range}`
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    signal,
  })

  if (response.status === 204 || response.status === 404) {
    return { stationCode, range, points: [] }
  }
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorMessage(response))
  }

  const body: unknown = await response.json()
  return decodeStationHistory(body, stationCode, range)
}

export const fetchSessionStatus = async (
  signal: AbortSignal,
): Promise<SessionStatus> => {
  const response = await fetch("/api/session", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  })
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorMessage(response))
  }

  const body: unknown = await response.json()
  const record = toRecord(body)
  if (
    record === undefined ||
    typeof record.verified !== "boolean" ||
    typeof record.turnstileSiteKey !== "string" ||
    record.turnstileSiteKey.length === 0
  ) throw new Error("La configuration de sécurité reçue est invalide")
  return {
    verified: record.verified,
    turnstileSiteKey: record.turnstileSiteKey,
  }
}

export const verifyTurnstile = async (
  turnstileToken: string,
  signal: AbortSignal,
): Promise<void> => {
  const response = await fetch("/api/session", {
    method: "POST",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ turnstileToken }),
    signal,
  })
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorMessage(response))
  }
}

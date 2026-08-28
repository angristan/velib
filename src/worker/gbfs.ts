import { Context, Effect, Layer, Option, Schema } from "effect"

import {
  CollectedStatus,
  CompactStation,
  FeedError,
  GbfsInformationFeed,
  GbfsStatusFeed,
  GbfsStatusStation,
  StationMetadata
} from "./domain"

const STATUS_URL =
  "https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_status.json"
const INFORMATION_URL =
  "https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_information.json"
const MAX_MALFORMED_STATUS_STATIONS = 5

export interface CollectedMetadata {
  readonly sourceUpdatedAt: number
  readonly stations: ReadonlyArray<StationMetadata>
}

export class GbfsClient extends Context.Service<GbfsClient, {
  readonly fetchStatus: () => Effect.Effect<CollectedStatus, FeedError>
  readonly fetchInformation: () => Effect.Effect<CollectedMetadata, FeedError>
}>()("velib/GbfsClient") {}

const fetchJson = Effect.fn("GbfsClient.fetchJson")(function*(url: string, operation: string) {
  const response = yield* Effect.tryPromise({
    try: (signal) =>
      fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        headers: { accept: "application/json" }
      }),
    catch: (cause) =>
      FeedError.make({
        operation,
        detail: "The Vélib feed request failed",
        cause
      })
  })

  if (!response.ok) {
    return yield* FeedError.make({
      operation,
      detail: `The Vélib feed returned HTTP ${response.status}`
    })
  }

  return yield* Effect.tryPromise({
    try: async (): Promise<unknown> => await response.json(),
    catch: (cause) =>
      FeedError.make({
        operation,
        detail: "The Vélib feed did not contain valid JSON",
        cause
      })
  })
})

const decodeFeedValue = <S extends Schema.Top>(
  schema: S,
  input: unknown,
  operation: string,
) => Schema.decodeUnknownEffect(schema)(input).pipe(
  Effect.mapError((cause) => FeedError.make({ operation, detail: cause.message, cause })),
)

const decodeStatusStation = Schema.decodeUnknownOption(GbfsStatusStation)

const parseStationCode = (value: string): number | null => {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

const invalidStationCode = (value: string): FeedError =>
  FeedError.make({
    operation: "decodeStationCode",
    detail: `Invalid station code: ${value}`
  })

const fetchInformation = Effect.fn("GbfsClient.fetchInformation")(function*() {
  const input = yield* fetchJson(INFORMATION_URL, "fetchInformation")
  const feed = yield* Schema.decodeUnknownEffect(GbfsInformationFeed)(input).pipe(
    Effect.mapError((cause) =>
      FeedError.make({
        operation: "decodeInformation",
        detail: cause.message,
        cause
      })
    )
  )

  const stationInputs: Array<unknown> = []
  for (const station of feed.data.stations) {
    const code = parseStationCode(station.stationCode)
    if (code === null) return yield* invalidStationCode(station.stationCode)
    stationInputs.push({
      stationCode: code,
      stationId: String(station.station_id),
      name: station.name,
      latitude: station.lat,
      longitude: station.lon,
      capacity: station.capacity,
      metadataUpdatedAt: feed.lastUpdatedOther
    })
  }
  const stations = yield* decodeFeedValue(
    Schema.Array(StationMetadata),
    stationInputs,
    "decodeInformationStation"
  )

  return {
    sourceUpdatedAt: feed.lastUpdatedOther,
    stations
  }
})

const fetchStatus = Effect.fn("GbfsClient.fetchStatus")(function*() {
  const input = yield* fetchJson(STATUS_URL, "fetchStatus")
  const feed = yield* Schema.decodeUnknownEffect(GbfsStatusFeed)(input).pipe(
    Effect.mapError((cause) =>
      FeedError.make({
        operation: "decodeStatus",
        detail: cause.message,
        cause
      })
    )
  )

  const decodedStations: Array<typeof GbfsStatusStation.Type> = []
  let malformedStations = 0
  for (const stationInput of feed.data.stations) {
    const decoded = decodeStatusStation(stationInput)
    if (Option.isNone(decoded)) {
      malformedStations += 1
      continue
    }
    decodedStations.push(decoded.value)
  }

  if (
    malformedStations > MAX_MALFORMED_STATUS_STATIONS ||
    decodedStations.length === 0
  ) {
    return yield* FeedError.make({
      operation: "decodeStatusStation",
      detail: `The Vélib feed contained ${malformedStations} malformed station rows`
    })
  }

  const missingStationCodes = decodedStations.filter(
    ({ stationCode }) => stationCode === null
  ).length
  const authoritativeCodes = new Map<string, number>()
  let informationSourceUpdatedAt: number | null = null
  if (missingStationCodes > 0) {
    const information = yield* fetchInformation()
    informationSourceUpdatedAt = information.sourceUpdatedAt
    for (const station of information.stations) {
      if (authoritativeCodes.has(station.stationId)) {
        return yield* FeedError.make({
          operation: "resolveStatusStationCode",
          detail: "The Vélib information feed contained duplicate station IDs"
        })
      }
      authoritativeCodes.set(station.stationId, station.stationCode)
    }

    const unresolvedStationCodes = decodedStations.filter(
      ({ stationCode, station_id }) =>
        stationCode === null && !authoritativeCodes.has(String(station_id))
    ).length
    if (unresolvedStationCodes > 0) {
      return yield* FeedError.make({
        operation: "resolveStatusStationCode",
        detail: `The Vélib information feed could not resolve ${unresolvedStationCodes} of ${missingStationCodes} station codes`
      })
    }
  }

  const stationInputs: Array<unknown> = []
  const seenStationCodes = new Set<number>()
  for (const station of decodedStations) {
    const code = station.stationCode === null
      ? authoritativeCodes.get(String(station.station_id))
      : parseStationCode(station.stationCode)
    if (code === null) return yield* invalidStationCode(station.stationCode ?? "null")
    if (code === undefined) {
      return yield* FeedError.make({
        operation: "resolveStatusStationCode",
        detail: "The Vélib information feed omitted a required station mapping"
      })
    }
    if (seenStationCodes.has(code)) {
      return yield* FeedError.make({
        operation: "resolveStatusStationCode",
        detail: "The Vélib status feed resolved duplicate station codes"
      })
    }
    seenStationCodes.add(code)

    let mechanical = 0
    let electric = 0
    for (const available of station.num_bikes_available_types) {
      if (available.mechanical !== undefined) mechanical += available.mechanical
      if (available.ebike !== undefined) electric += available.ebike
    }

    const operative =
      (station.is_installed === true || station.is_installed === 1) &&
      (station.is_returning === true || station.is_returning === 1) &&
      (station.is_renting === true || station.is_renting === 1)

    stationInputs.push({
      c: code,
      m: mechanical,
      e: electric,
      d: station.num_docks_available,
      o: operative ? 1 : 0,
      r: station.last_reported
    })
  }

  if (missingStationCodes > 0) {
    yield* Effect.logWarning("Recovered missing Vélib status station codes", {
      missingStationCodes,
      stationCount: feed.data.stations.length,
      statusSourceUpdatedAt: feed.lastUpdatedOther,
      informationSourceUpdatedAt
    })
  }
  if (malformedStations > 0) {
    yield* Effect.logWarning("Skipped malformed Vélib status rows", {
      malformedStations,
      stationCount: feed.data.stations.length
    })
  }

  const stations = yield* decodeFeedValue(
    Schema.Array(CompactStation),
    stationInputs,
    "decodeStatusStation"
  )

  return {
    sourceUpdatedAt: feed.lastUpdatedOther,
    stations
  }
})

export const GbfsClientLive = Layer.succeed(GbfsClient, {
  fetchStatus,
  fetchInformation
})

import { Context, Effect, Layer, Schema } from "effect"

import {
  CollectedStatus,
  CompactStation,
  FeedError,
  GbfsInformationFeed,
  GbfsStatusFeed,
  StationMetadata
} from "./domain"

const STATUS_URL =
  "https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_status.json"
const INFORMATION_URL =
  "https://velib-metropole-opendata.smovengo.cloud/opendata/Velib_Metropole/station_information.json"

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

const stationCode = Effect.fn("GbfsClient.stationCode")(function*(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return yield* FeedError.make({
      operation: "decodeStationCode",
      detail: `Invalid station code: ${value}`
    })
  }
  return parsed
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

  const stations = yield* Effect.forEach(feed.data.stations, (station) =>
    Effect.gen(function*() {
      const code = yield* stationCode(station.stationCode)
      let mechanical = 0
      let electric = 0

      for (const available of station.num_bikes_available_types) {
        if (available.mechanical !== undefined) {
          mechanical += available.mechanical
        }
        if (available.ebike !== undefined) {
          electric += available.ebike
        }
      }

      const operative =
        (station.is_installed === true || station.is_installed === 1) &&
        (station.is_returning === true || station.is_returning === 1) &&
        (station.is_renting === true || station.is_renting === 1)

      return CompactStation.make({
        c: code,
        m: mechanical,
        e: electric,
        d: station.num_docks_available,
        o: operative ? 1 : 0,
        r: station.last_reported
      })
    })
  )

  return {
    sourceUpdatedAt: feed.lastUpdatedOther,
    stations
  }
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

  const stations = yield* Effect.forEach(feed.data.stations, (station) =>
    Effect.map(stationCode(station.stationCode), (code) =>
      StationMetadata.make({
        stationCode: code,
        stationId: String(station.station_id),
        name: station.name,
        latitude: station.lat,
        longitude: station.lon,
        capacity: station.capacity,
        metadataUpdatedAt: feed.lastUpdatedOther
      })
    )
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

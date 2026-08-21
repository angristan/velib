import { Context, Effect, Layer, Schema } from "effect"

import {
  type HistoryRange,
  type HistoryResponse,
  NotFoundError,
  type RepositoryError,
  type RollupHistoryPoint
} from "./domain"
import { VelibRepository } from "./repository"
import {
  aggregateRollupPoints,
  DAY_SECONDS,
  HOUR_SECONDS,
  RollupArchive,
  type RollupArchiveError,
  SIX_HOURS_SECONDS
} from "./rollup-archive"

export class StationHistoryError extends Schema.TaggedErrorClass<StationHistoryError>()(
  "StationHistoryError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export class StationHistory extends Context.Service<StationHistory, {
  readonly history: (
    code: number,
    range: HistoryRange,
    now: number
  ) => Effect.Effect<HistoryResponse, RepositoryError | NotFoundError | StationHistoryError>
}>()("velib/StationHistory") {}

const isLongRange = (range: HistoryRange): range is "30d" | "1y" =>
  range === "30d" || range === "1y"

const isRollupPoint = (point: HistoryResponse["points"][number]): point is RollupHistoryPoint =>
  "sampleCount" in point

const stationHistoryError = (error: RollupArchiveError): StationHistoryError =>
  StationHistoryError.make({
    operation: error.operation,
    detail: error.detail,
    cause: error.cause
  })

export const D1StationHistoryLive = Layer.effect(StationHistory)(
  Effect.gen(function*() {
    const repository = yield* VelibRepository
    return { history: repository.history }
  })
)

export const TieredStationHistoryLive = Layer.effect(StationHistory)(
  Effect.gen(function*() {
    const repository = yield* VelibRepository
    const archive = yield* RollupArchive

    return {
      history: (code, range, now) => {
        if (!isLongRange(range)) return repository.history(code, range, now)

        return Effect.gen(function*() {
          const [hotHistory, archivedHourly] = yield* Effect.all([
            repository.history(code, "7d", now),
            archive.hourlyHistory(code, range, now).pipe(
              Effect.mapError(stationHistoryError)
            )
          ])
          const resolutionSeconds = range === "30d" ? HOUR_SECONDS : SIX_HOURS_SECONDS
          const rangeSeconds = range === "30d" ? 30 * DAY_SECONDS : 365 * DAY_SECONDS
          // Ignore D1's potentially partial oldest hour. Six complete days still
          // provide a wide overlap while monthly object delivery catches up.
          const hotFrom = Math.ceil((now - 6 * DAY_SECONDS) / HOUR_SECONDS) * HOUR_SECONDS
          const hotHourly = aggregateRollupPoints(
            hotHistory.points.filter(isRollupPoint).filter((point) => point.observedAt >= hotFrom),
            HOUR_SECONDS
          )
          const merged = new Map<number, RollupHistoryPoint>()
          for (const point of archivedHourly) merged.set(point.observedAt, point)
          // D1 is authoritative for the overlap while the current month object is mutable.
          for (const point of hotHourly) merged.set(point.observedAt, point)
          const hourly = [...merged.values()]
            .filter((point) => point.observedAt >= now - rangeSeconds && point.observedAt <= now)
            .sort((left, right) => left.observedAt - right.observedAt)
          const points = (resolutionSeconds === HOUR_SECONDS
            ? hourly
            : aggregateRollupPoints(hourly, resolutionSeconds))
            .filter((point) => point.observedAt >= now - rangeSeconds)

          return {
            station: hotHistory.station,
            range,
            resolutionSeconds,
            points
          } satisfies HistoryResponse
        })
      }
    }
  })
)

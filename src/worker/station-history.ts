import { Context, Effect, Layer, Schema } from "effect"

import {
  Aggregate,
  type HistoryRange,
  type HistoryResponse,
  NotFoundError,
  type RepositoryError,
  ROLLUP_SECONDS,
  type RollupHistoryPoint
} from "./domain"
import { VelibRepository } from "./repository"

const R2_HISTORY_TABLE = "velib.station_observations_v1"
const MAX_HISTORY_ROWS = 2_020

const SqlNumber = Schema.Union([Schema.Number, Schema.NumberFromString])
const R2HistoryRow = Schema.Struct({
  bucket_at: SqlNumber,
  sample_count: SqlNumber,
  mechanical_min: SqlNumber,
  mechanical_max: SqlNumber,
  mechanical_avg: SqlNumber,
  mechanical_removed: SqlNumber,
  mechanical_returned: SqlNumber,
  electric_min: SqlNumber,
  electric_max: SqlNumber,
  electric_avg: SqlNumber,
  electric_removed: SqlNumber,
  electric_returned: SqlNumber,
  docks_min: SqlNumber,
  docks_max: SqlNumber,
  docks_avg: SqlNumber,
  unavailable_min: SqlNumber,
  unavailable_max: SqlNumber,
  unavailable_avg: SqlNumber,
  operative_samples: SqlNumber
})

const R2SqlResponse = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    request_id: Schema.optionalKey(Schema.String),
    rows: Schema.Array(R2HistoryRow),
    metrics: Schema.optionalKey(Schema.Struct({
      r2_requests_count: SqlNumber,
      files_scanned: SqlNumber,
      bytes_scanned: SqlNumber
    }))
  }))),
  errors: Schema.optionalKey(Schema.Array(Schema.Unknown))
})

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

export interface R2HistoryConfig {
  readonly accountId: string
  readonly bucket: string
  readonly token: string
}

const historyRangeSeconds = (range: Exclude<HistoryRange, "1h">): number =>
  range === "3h" ? 3 * 60 * 60 : range === "1d" ? 24 * 60 * 60 : 7 * 24 * 60 * 60

export const r2HistorySql = (
  code: number,
  range: Exclude<HistoryRange, "1h">,
  now: number
): string => {
  const from = now - historyRangeSeconds(range)
  // D1 finalizes one bucket late so delayed Cron observations can arrive.
  const latestCompletedBucket = Math.floor(now / ROLLUP_SECONDS) * ROLLUP_SECONDS -
    2 * ROLLUP_SECONDS

  return `WITH unique_samples AS (
  SELECT
    event_id, observed_at, source_updated_at, bucket_at, station_code,
    capacity, mechanical, electric, docks, unavailable, operative, last_reported_at
  FROM ${R2_HISTORY_TABLE}
  WHERE station_code = ${code}
    AND bucket_at >= ${from}
    AND bucket_at <= ${latestCompletedBucket}
  QUALIFY ROW_NUMBER() OVER (
    PARTITION BY event_id ORDER BY __ingest_ts DESC
  ) = 1
), ordered_samples AS (
  SELECT
    *,
    LAG(observed_at) OVER (
      PARTITION BY bucket_at ORDER BY observed_at, source_updated_at
    ) AS previous_observed_at,
    LAG(mechanical) OVER (
      PARTITION BY bucket_at ORDER BY observed_at, source_updated_at
    ) AS previous_mechanical,
    LAG(electric) OVER (
      PARTITION BY bucket_at ORDER BY observed_at, source_updated_at
    ) AS previous_electric
  FROM unique_samples
), samples AS (
  SELECT
    *,
    CASE
      WHEN observed_at - previous_observed_at = 60
        AND mechanical < previous_mechanical
      THEN previous_mechanical - mechanical
      ELSE 0
    END AS mechanical_removed,
    CASE
      WHEN observed_at - previous_observed_at = 60
        AND mechanical > previous_mechanical
      THEN mechanical - previous_mechanical
      ELSE 0
    END AS mechanical_returned,
    CASE
      WHEN observed_at - previous_observed_at = 60
        AND electric < previous_electric
      THEN previous_electric - electric
      ELSE 0
    END AS electric_removed,
    CASE
      WHEN observed_at - previous_observed_at = 60
        AND electric > previous_electric
      THEN electric - previous_electric
      ELSE 0
    END AS electric_returned
  FROM ordered_samples
)
SELECT
  bucket_at,
  COUNT(*) AS sample_count,
  MIN(mechanical) AS mechanical_min,
  MAX(mechanical) AS mechanical_max,
  AVG(mechanical) AS mechanical_avg,
  SUM(mechanical_removed) AS mechanical_removed,
  SUM(mechanical_returned) AS mechanical_returned,
  MIN(electric) AS electric_min,
  MAX(electric) AS electric_max,
  AVG(electric) AS electric_avg,
  SUM(electric_removed) AS electric_removed,
  SUM(electric_returned) AS electric_returned,
  MIN(docks) AS docks_min,
  MAX(docks) AS docks_max,
  AVG(docks) AS docks_avg,
  MIN(unavailable) AS unavailable_min,
  MAX(unavailable) AS unavailable_max,
  AVG(unavailable) AS unavailable_avg,
  SUM(CASE WHEN operative THEN 1 ELSE 0 END) AS operative_samples
FROM samples
GROUP BY bucket_at
ORDER BY bucket_at
LIMIT ${MAX_HISTORY_ROWS};`
}

const pointFromRow = (row: typeof R2HistoryRow.Type): RollupHistoryPoint => ({
  observedAt: row.bucket_at,
  sampleCount: row.sample_count,
  mechanical: Aggregate.make({
    min: row.mechanical_min,
    max: row.mechanical_max,
    avg: row.mechanical_avg
  }),
  mechanicalRemoved: row.mechanical_removed,
  mechanicalReturned: row.mechanical_returned,
  electric: Aggregate.make({
    min: row.electric_min,
    max: row.electric_max,
    avg: row.electric_avg
  }),
  electricRemoved: row.electric_removed,
  electricReturned: row.electric_returned,
  docks: Aggregate.make({
    min: row.docks_min,
    max: row.docks_max,
    avg: row.docks_avg
  }),
  unavailable: Aggregate.make({
    min: row.unavailable_min,
    max: row.unavailable_max,
    avg: row.unavailable_avg
  }),
  operativeSamples: row.operative_samples
})

export const D1StationHistoryLive = Layer.effect(StationHistory)(
  Effect.gen(function*() {
    const repository = yield* VelibRepository
    return { history: repository.history }
  })
)

export const makeR2StationHistoryLive = (
  config: R2HistoryConfig,
  fetchImplementation: typeof fetch = globalThis.fetch
) => Layer.effect(StationHistory)(
  Effect.gen(function*() {
    const repository = yield* VelibRepository

    const queryHistory = Effect.fn("StationHistory.r2Query")(function*(
      code: number,
      range: Exclude<HistoryRange, "1h">,
      now: number
    ) {
      const station = yield* repository.metadata(code)
      const query = r2HistorySql(code, range, now)
      const endpoint = `https://api.sql.cloudflarestorage.com/api/v1/accounts/${encodeURIComponent(config.accountId)}/r2-sql/query/${encodeURIComponent(config.bucket)}`

      const response = yield* Effect.tryPromise({
        try: (signal) => fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.token}`,
            "content-type": "application/json"
          },
          body: JSON.stringify({ query }),
          signal
        }),
        catch: (cause) => StationHistoryError.make({
          operation: "r2Sql.fetch",
          detail: "R2 SQL history query failed",
          cause
        })
      })

      const input = yield* Effect.tryPromise({
        try: async () => await response.json(),
        catch: (cause) => StationHistoryError.make({
          operation: "r2Sql.response",
          detail: "R2 SQL returned an invalid response body",
          cause
        })
      })
      const decoded = yield* Schema.decodeUnknownEffect(R2SqlResponse)(input).pipe(
        Effect.mapError((cause) => StationHistoryError.make({
          operation: "r2Sql.decode",
          detail: "R2 SQL returned invalid history data",
          cause
        }))
      )

      if (!response.ok || !decoded.success || decoded.result === null || decoded.result === undefined) {
        return yield* StationHistoryError.make({
          operation: "r2Sql.query",
          detail: `R2 SQL history query was rejected with status ${response.status}`
        })
      }
      if (decoded.result.rows.length >= MAX_HISTORY_ROWS) {
        return yield* StationHistoryError.make({
          operation: "r2Sql.limit",
          detail: "R2 SQL history query reached its result limit"
        })
      }

      yield* Effect.annotateCurrentSpan({
        historyBackend: "r2-sql",
        historyRange: range,
        historyRows: decoded.result.rows.length,
        r2SqlRequestId: decoded.result.request_id ?? "unknown",
        r2SqlRequests: decoded.result.metrics?.r2_requests_count ?? 0,
        r2SqlFilesScanned: decoded.result.metrics?.files_scanned ?? 0,
        r2SqlBytesScanned: decoded.result.metrics?.bytes_scanned ?? 0
      })

      return {
        station,
        range,
        resolutionSeconds: ROLLUP_SECONDS,
        points: decoded.result.rows.map(pointFromRow)
      } satisfies HistoryResponse
    })

    return {
      history: (code, range, now) => range === "1h"
        ? repository.history(code, range, now)
        : queryHistory(code, range, now)
    }
  })
)

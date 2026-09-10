import { Context, Effect, Layer, Schema } from "effect"

import {
  Aggregate,
  type HistoryRange,
  RETENTION_SECONDS,
  type RollupHistoryPoint
} from "./domain"
import {
  decodeRollupBucket,
  rollupBucketShard,
  stationPointFromBucket
} from "./rollup-bucket"

export const HOUR_SECONDS = 60 * 60
export const DAY_SECONDS = 24 * HOUR_SECONDS
export const SIX_HOURS_SECONDS = 6 * HOUR_SECONDS
export const ROLLUP_ARCHIVE_RETENTION_SECONDS = 365 * DAY_SECONDS
const MAX_COMPRESSED_OBJECT_BYTES = 1024 * 1024
const MAX_DECOMPRESSED_OBJECT_BYTES = 4 * 1024 * 1024
const MAX_HOURLY_POINTS_PER_MONTH = 31 * 24

export type ArchivedHistoryRange = Extract<HistoryRange, "30d" | "1y">

const PackedRollup = Schema.Tuple([
  Schema.Number, // observedAt
  Schema.Number, // sampleCount
  Schema.Number, // mechanical min
  Schema.Number, // mechanical max
  Schema.Number, // mechanical average
  Schema.Number, // mechanical removed
  Schema.Number, // mechanical returned
  Schema.Number, // electric min
  Schema.Number, // electric max
  Schema.Number, // electric average
  Schema.Number, // electric removed
  Schema.Number, // electric returned
  Schema.Number, // docks min
  Schema.Number, // docks max
  Schema.Number, // docks average
  Schema.Number, // unavailable min
  Schema.Number, // unavailable max
  Schema.Number, // unavailable average
  Schema.Number // operative samples
])

const DailyRollupBlock = Schema.Struct({
  v: Schema.Literal(1),
  stationCode: Schema.Number,
  dayAt: Schema.Number,
  hourly: Schema.Array(PackedRollup)
})

const MonthlyRollupObject = Schema.Struct({
  v: Schema.Literal(1),
  stationCode: Schema.Number,
  monthAt: Schema.Number,
  completeThrough: Schema.Number,
  hourly: Schema.Array(PackedRollup)
})

const RollupBucketPayload = Schema.Union([
  Schema.Array(Schema.Number),
  Schema.Uint8Array,
  Schema.instanceOf(ArrayBuffer)
])
const RollupBucketRow = Schema.Struct({
  bucket_at: Schema.Number,
  shard: Schema.Number,
  payload: RollupBucketPayload
})

const RollupRow = Schema.Struct({
  bucket_at: Schema.Number,
  sample_count: Schema.Number,
  mechanical_min: Schema.Number,
  mechanical_max: Schema.Number,
  mechanical_avg: Schema.Number,
  mechanical_removed: Schema.Number,
  mechanical_returned: Schema.Number,
  electric_min: Schema.Number,
  electric_max: Schema.Number,
  electric_avg: Schema.Number,
  electric_removed: Schema.Number,
  electric_returned: Schema.Number,
  docks_min: Schema.Number,
  docks_max: Schema.Number,
  docks_avg: Schema.Number,
  unavailable_min: Schema.Number,
  unavailable_max: Schema.Number,
  unavailable_avg: Schema.Number,
  operative_samples: Schema.Number
})

const ArchiveJobRow = Schema.Struct({
  day_at: Schema.Number,
  station_code: Schema.Number,
  payload: Schema.NullOr(Schema.String),
  attempts: Schema.Number,
  last_attempt_at: Schema.Number
})

const ArchivePayload = Schema.Union([
  Schema.Array(Schema.Number),
  Schema.Uint8Array,
  Schema.instanceOf(ArrayBuffer)
])

const HistoryArchiveRow = Schema.Struct({
  month_at: Schema.Number,
  complete_through: Schema.Number,
  payload: ArchivePayload
})

const LegacyArchiveObjectRow = Schema.Struct({
  station_code: Schema.Number,
  month_at: Schema.Number,
  complete_through: Schema.Number,
  etag: Schema.String
})

export class RollupArchiveError extends Schema.TaggedErrorClass<RollupArchiveError>()(
  "RollupArchiveError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optionalKey(Schema.Defect())
  }
) {}

export interface RollupArchiveMaintenance {
  readonly enqueuedDays: number
  readonly prepared: number
  readonly delivered: number
  readonly backfilled: number
  readonly failed: number
}

export class RollupArchive extends Context.Service<RollupArchive, {
  readonly maintain: (
    now: number,
    options?: {
      readonly prepareLimit?: number
      readonly deliveryLimit?: number
      readonly backfillLimit?: number
    }
  ) => Effect.Effect<RollupArchiveMaintenance, RollupArchiveError>
  readonly hourlyHistory: (
    stationCode: number,
    range: ArchivedHistoryRange,
    now: number
  ) => Effect.Effect<ReadonlyArray<RollupHistoryPoint>, RollupArchiveError>
}>()("velib/RollupArchive") {}

const archiveError = (operation: string, detail: string, cause?: unknown) =>
  RollupArchiveError.make({ operation, detail, ...(cause === undefined ? {} : { cause }) })

const allRows = Effect.fn("RollupArchive.allRows")(function*(
  statement: D1PreparedStatement,
  operation: string
) {
  return yield* Effect.tryPromise({
    try: async () => (await statement.all<Record<string, unknown>>()).results,
    catch: (cause) => archiveError(operation, `D1 operation failed: ${operation}`, cause)
  })
})

const runStatement = Effect.fn("RollupArchive.runStatement")(function*(
  statement: D1PreparedStatement,
  operation: string
) {
  yield* Effect.tryPromise({
    try: async () => {
      await statement.run()
    },
    catch: (cause) => archiveError(operation, `D1 operation failed: ${operation}`, cause)
  })
})

const runBatch = Effect.fn("RollupArchive.runBatch")(function*(
  db: D1Database,
  statements: ReadonlyArray<D1PreparedStatement>,
  operation: string
) {
  yield* Effect.tryPromise({
    try: async () => {
      await db.batch([...statements])
    },
    catch: (cause) => archiveError(operation, `D1 operation failed: ${operation}`, cause)
  })
})

const decode = <S extends Schema.Top>(schema: S, input: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => archiveError(operation, `Invalid rollup archive data: ${operation}`, cause))
  )

const parseJson = Effect.fn("RollupArchive.parseJson")(function*(text: string, operation: string) {
  const input = yield* Effect.try({
    try: (): unknown => JSON.parse(text),
    catch: (cause) => archiveError(operation, `Invalid rollup archive JSON: ${operation}`, cause)
  })
  return input
})

const stringify = Effect.fn("RollupArchive.stringify")(function*(value: unknown, operation: string) {
  return yield* Effect.try({
    try: () => JSON.stringify(value),
    catch: (cause) => archiveError(operation, `Could not serialize rollup archive: ${operation}`, cause)
  })
})

const gzip = Effect.fn("RollupArchive.gzip")(function*(text: string) {
  return yield* Effect.tryPromise({
    try: async () => {
      const input = new Blob([new TextEncoder().encode(text)]).stream()
      return await new Response(input.pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
    },
    catch: (cause) => archiveError("gzip", "Could not compress rollup archive object", cause)
  })
})

const gunzip = Effect.fn("RollupArchive.gunzip")(function*(
  payload: ArrayBuffer | Uint8Array<ArrayBufferLike> | ReadonlyArray<number>
) {
  return yield* Effect.tryPromise({
    try: async () => {
      const bytes = payload instanceof ArrayBuffer ? payload : Uint8Array.from(payload)
      const input = new Blob([bytes]).stream()
      const reader = input.pipeThrough(new DecompressionStream("gzip")).getReader()
      const decoder = new TextDecoder()
      let size = 0
      let text = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_DECOMPRESSED_OBJECT_BYTES) {
          await reader.cancel("Rollup archive object is too large")
          throw new Error("Decompressed rollup archive object exceeds its size limit")
        }
        text += decoder.decode(value, { stream: true })
      }
      return text + decoder.decode()
    },
    catch: (cause) => archiveError("gunzip", "Could not decompress rollup archive object", cause)
  })
})

const pointFromRow = (row: typeof RollupRow.Type): RollupHistoryPoint => ({
  observedAt: row.bucket_at,
  sampleCount: row.sample_count,
  mechanical: Aggregate.make({ min: row.mechanical_min, max: row.mechanical_max, avg: row.mechanical_avg }),
  mechanicalRemoved: row.mechanical_removed,
  mechanicalReturned: row.mechanical_returned,
  electric: Aggregate.make({ min: row.electric_min, max: row.electric_max, avg: row.electric_avg }),
  electricRemoved: row.electric_removed,
  electricReturned: row.electric_returned,
  docks: Aggregate.make({ min: row.docks_min, max: row.docks_max, avg: row.docks_avg }),
  unavailable: Aggregate.make({ min: row.unavailable_min, max: row.unavailable_max, avg: row.unavailable_avg }),
  operativeSamples: row.operative_samples
})

const packPoint = (point: RollupHistoryPoint): typeof PackedRollup.Type => [
  point.observedAt,
  point.sampleCount,
  point.mechanical.min,
  point.mechanical.max,
  point.mechanical.avg,
  point.mechanicalRemoved,
  point.mechanicalReturned,
  point.electric.min,
  point.electric.max,
  point.electric.avg,
  point.electricRemoved,
  point.electricReturned,
  point.docks.min,
  point.docks.max,
  point.docks.avg,
  point.unavailable.min,
  point.unavailable.max,
  point.unavailable.avg,
  point.operativeSamples
]

const unpackPoint = (point: typeof PackedRollup.Type): RollupHistoryPoint => ({
  observedAt: point[0],
  sampleCount: point[1],
  mechanical: Aggregate.make({ min: point[2], max: point[3], avg: point[4] }),
  mechanicalRemoved: point[5],
  mechanicalReturned: point[6],
  electric: Aggregate.make({ min: point[7], max: point[8], avg: point[9] }),
  electricRemoved: point[10],
  electricReturned: point[11],
  docks: Aggregate.make({ min: point[12], max: point[13], avg: point[14] }),
  unavailable: Aggregate.make({ min: point[15], max: point[16], avg: point[17] }),
  operativeSamples: point[18]
})

export const aggregateRollupPoints = (
  points: ReadonlyArray<RollupHistoryPoint>,
  resolutionSeconds: number
): Array<RollupHistoryPoint> => {
  const groups = new Map<number, Array<RollupHistoryPoint>>()
  for (const point of points) {
    const bucketAt = Math.floor(point.observedAt / resolutionSeconds) * resolutionSeconds
    const group = groups.get(bucketAt)
    if (group === undefined) groups.set(bucketAt, [point])
    else group.push(point)
  }

  return [...groups.entries()].sort(([left], [right]) => left - right).map(([observedAt, group]) => {
    const sampleCount = group.reduce((sum, point) => sum + point.sampleCount, 0)
    const weighted = (select: (point: RollupHistoryPoint) => number): number =>
      sampleCount === 0
        ? 0
        : group.reduce((sum, point) => sum + select(point) * point.sampleCount, 0) / sampleCount
    return {
      observedAt,
      sampleCount,
      mechanical: Aggregate.make({
        min: Math.min(...group.map((point) => point.mechanical.min)),
        max: Math.max(...group.map((point) => point.mechanical.max)),
        avg: weighted((point) => point.mechanical.avg)
      }),
      mechanicalRemoved: group.reduce((sum, point) => sum + point.mechanicalRemoved, 0),
      mechanicalReturned: group.reduce((sum, point) => sum + point.mechanicalReturned, 0),
      electric: Aggregate.make({
        min: Math.min(...group.map((point) => point.electric.min)),
        max: Math.max(...group.map((point) => point.electric.max)),
        avg: weighted((point) => point.electric.avg)
      }),
      electricRemoved: group.reduce((sum, point) => sum + point.electricRemoved, 0),
      electricReturned: group.reduce((sum, point) => sum + point.electricReturned, 0),
      docks: Aggregate.make({
        min: Math.min(...group.map((point) => point.docks.min)),
        max: Math.max(...group.map((point) => point.docks.max)),
        avg: weighted((point) => point.docks.avg)
      }),
      unavailable: Aggregate.make({
        min: Math.min(...group.map((point) => point.unavailable.min)),
        max: Math.max(...group.map((point) => point.unavailable.max)),
        avg: weighted((point) => point.unavailable.avg)
      }),
      operativeSamples: group.reduce((sum, point) => sum + point.operativeSamples, 0)
    }
  })
}

export const utcDayStart = (timestamp: number): number =>
  Math.floor(timestamp / DAY_SECONDS) * DAY_SECONDS

export const utcMonthStart = (timestamp: number): number => {
  const date = new Date(timestamp * 1_000)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1_000
}

export const rollupObjectKey = (stationCode: number, monthAt: number): string =>
  `rollups/v1/stations/${stationCode}/${monthAt}.json.gz`

const validatePackedPoints = (
  points: ReadonlyArray<typeof PackedRollup.Type>,
  from: number,
  to: number,
  operation: string
): Effect.Effect<void, RollupArchiveError> => {
  let previous = from - 1
  for (const point of points) {
    if (
      points.length > MAX_HOURLY_POINTS_PER_MONTH ||
      point[0] < from || point[0] >= to || point[0] % HOUR_SECONDS !== 0 ||
      point[0] <= previous
    ) {
      return Effect.fail(archiveError(operation, "Rollup archive timestamps are invalid"))
    }
    previous = point[0]
  }
  return Effect.void
}

const monthStartsBetween = (from: number, to: number): Array<number> => {
  if (to < from) return []
  const months: number[] = []
  const cursor = new Date(utcMonthStart(from) * 1_000)
  const last = utcMonthStart(to)
  while (cursor.getTime() / 1_000 <= last && months.length < 14) {
    months.push(cursor.getTime() / 1_000)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return months
}

export const archiveRetryDelaySeconds = (attempts: number): number =>
  Math.min(15 * 60, 60 * 2 ** Math.min(Math.max(0, attempts - 1), 4))

const makeRollupArchive = (db: D1Database, legacyBucket?: R2Bucket): RollupArchive["Service"] => {
  const enqueueDay = Effect.fn("RollupArchive.enqueueDay")(function*(dayAt: number, now: number) {
    yield* runBatch(db, [
      db.prepare(
        `INSERT OR IGNORE INTO station_rollup_archive_jobs
           (day_at, station_code, next_attempt_at)
         SELECT ?, station_code, ? FROM stations
         WHERE NOT EXISTS (
           SELECT 1 FROM station_rollup_archive_days WHERE day_at = ?
         )`
      ).bind(dayAt, now, dayAt),
      db.prepare(
        `INSERT OR IGNORE INTO station_rollup_archive_days (day_at, enqueued_at)
         VALUES (?, ?)`
      ).bind(dayAt, now)
    ], "enqueueDay")
  })

  const enqueueRecentDays = Effect.fn("RollupArchive.enqueueRecentDays")(function*(now: number) {
    if (now % HOUR_SECONDS !== 15 * 60) return 0
    const today = utcDayStart(now)
    const days = Array.from({ length: 6 }, (_, index) => today - (index + 1) * DAY_SECONDS)
    yield* Effect.forEach(days, (dayAt) => enqueueDay(dayAt, now), { discard: true })
    return days.length
  })

  const claim = Effect.fn("RollupArchive.claim")(function*(
    now: number,
    limit: number,
    payloadReady: boolean
  ) {
    const rows = yield* allRows(
      db.prepare(
        `UPDATE station_rollup_archive_jobs
         SET attempts = attempts + 1,
             last_attempt_at = ?,
             next_attempt_at = ?
         WHERE (day_at, station_code) IN (
           SELECT candidate.day_at, candidate.station_code
           FROM station_rollup_archive_jobs AS candidate
           WHERE candidate.next_attempt_at <= ?
             AND candidate.payload IS ${payloadReady ? "NOT NULL" : "NULL"}
             ${payloadReady ? `AND NOT EXISTS (
               SELECT 1 FROM station_rollup_archive_jobs AS older
               WHERE older.station_code = candidate.station_code
                 AND older.day_at < candidate.day_at
             )` : ""}
           ORDER BY candidate.day_at, candidate.station_code
           LIMIT ?
         )
         RETURNING day_at, station_code, payload, attempts, last_attempt_at`
      ).bind(now, now + 180, now, limit),
      payloadReady ? "claimDelivery" : "claimPreparation"
    )
    return yield* decode(Schema.Array(ArchiveJobRow), rows, "claim")
  })

  const retry = Effect.fn("RollupArchive.retry")(function*(
    job: typeof ArchiveJobRow.Type,
    now: number
  ) {
    yield* runStatement(
      db.prepare(
        `UPDATE station_rollup_archive_jobs
         SET next_attempt_at = ?, last_attempt_at = NULL
         WHERE day_at = ? AND station_code = ? AND last_attempt_at = ?`
      ).bind(
        now + archiveRetryDelaySeconds(job.attempts),
        job.day_at,
        job.station_code,
        job.last_attempt_at
      ),
      "retry"
    )
  })

  const prepareOne = Effect.fn("RollupArchive.prepareOne")(function*(
    job: typeof ArchiveJobRow.Type,
    now: number
  ) {
    if (job.day_at < utcDayStart(now - RETENTION_SECONDS)) {
      return yield* Effect.fail(archiveError(
        "prepare.expired",
        "Source rollups expired before this archive job was prepared"
      ))
    }
    const rows = yield* allRows(
      db.prepare(
        `SELECT bucket_at, sample_count,
           mechanical_min, mechanical_max, mechanical_avg, mechanical_removed, mechanical_returned,
           electric_min, electric_max, electric_avg, electric_removed, electric_returned,
           docks_min, docks_max, docks_avg,
           unavailable_min, unavailable_max, unavailable_avg, operative_samples
         FROM station_rollups_5m
         WHERE station_code = ? AND bucket_at >= ? AND bucket_at < ?
         ORDER BY bucket_at`
      ).bind(job.station_code, job.day_at, job.day_at + DAY_SECONDS),
      "prepare.rollups"
    )
    const decoded = yield* decode(Schema.Array(RollupRow), rows, "prepare.rollups")
    const points = new Map<number, RollupHistoryPoint>(decoded.map((row) => [
      row.bucket_at,
      pointFromRow(row)
    ]))
    const bucketRows = yield* allRows(
      db.prepare(
        `SELECT bucket_at, shard, payload
         FROM station_rollup_buckets_5m
         WHERE shard = ? AND bucket_at >= ? AND bucket_at < ?
         ORDER BY bucket_at`
      ).bind(
        rollupBucketShard(job.station_code),
        job.day_at,
        job.day_at + DAY_SECONDS
      ),
      "prepare.rollupBuckets"
    )
    const buckets = yield* decode(
      Schema.Array(RollupBucketRow),
      bucketRows,
      "prepare.rollupBuckets"
    )
    for (const row of buckets) {
      const bucket = yield* decodeRollupBucket(row.payload).pipe(
        Effect.mapError((cause) => archiveError(
          "prepare.rollupBucket",
          "Could not decode packed rollup bucket",
          cause
        ))
      )
      if (
        bucket[1] !== row.bucket_at ||
        row.shard !== rollupBucketShard(job.station_code)
      ) {
        return yield* Effect.fail(archiveError(
          "prepare.rollupBucket",
          "Packed rollup bucket does not match its D1 key"
        ))
      }
      const point = stationPointFromBucket(bucket, job.station_code)
      if (point !== null) points.set(point.observedAt, point)
    }
    const block = DailyRollupBlock.make({
      v: 1,
      stationCode: job.station_code,
      dayAt: job.day_at,
      hourly: aggregateRollupPoints(
        [...points.values()].sort((left, right) => left.observedAt - right.observedAt),
        HOUR_SECONDS
      ).map(packPoint)
    })
    const payload = yield* stringify(block, "prepare.payload")
    yield* runStatement(
      db.prepare(
        `UPDATE station_rollup_archive_jobs
         SET payload = ?, attempts = 0, next_attempt_at = ?, last_attempt_at = NULL
         WHERE day_at = ? AND station_code = ? AND last_attempt_at = ?`
      ).bind(payload, now, job.day_at, job.station_code, job.last_attempt_at),
      "prepare.save"
    )
  })

  const decodeMonthlyPayload = Effect.fn("RollupArchive.decodeMonthlyPayload")(function*(
    payload: ArrayBuffer | Uint8Array<ArrayBufferLike> | ReadonlyArray<number>,
    stationCode: number,
    monthAt: number,
    operation: string
  ) {
    const byteLength = payload instanceof ArrayBuffer || payload instanceof Uint8Array
      ? payload.byteLength
      : payload.length
    if (byteLength > MAX_COMPRESSED_OBJECT_BYTES) {
      return yield* Effect.fail(archiveError(operation, "Rollup archive exceeds its size limit"))
    }
    const text = yield* gunzip(payload)
    const input = yield* parseJson(text, `${operation}.json`)
    const monthly = yield* decode(MonthlyRollupObject, input, `${operation}.payload`)
    if (monthly.stationCode !== stationCode || monthly.monthAt !== monthAt) {
      return yield* Effect.fail(archiveError(
        `${operation}.identity`,
        "Rollup archive does not match its D1 key"
      ))
    }
    const date = new Date(monthAt * 1_000)
    const nextMonthAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1_000
    if (monthly.completeThrough < monthAt || monthly.completeThrough > nextMonthAt) {
      return yield* Effect.fail(archiveError(
        `${operation}.coverage`,
        "Rollup archive completion boundary is invalid"
      ))
    }
    yield* validatePackedPoints(monthly.hourly, monthAt, nextMonthAt, `${operation}.timestamps`)
    return monthly
  })

  const loadMonthlyArchive = Effect.fn("RollupArchive.loadMonthlyArchive")(function*(
    stationCode: number,
    monthAt: number
  ) {
    const rows = yield* allRows(
      db.prepare(
        `SELECT month_at, complete_through, payload
         FROM station_history_archives
         WHERE station_code = ? AND month_at = ?`
      ).bind(stationCode, monthAt),
      "history.load"
    )
    const decoded = yield* decode(Schema.Array(HistoryArchiveRow), rows, "history.load")
    const row = decoded[0]
    if (row === undefined) return null
    const monthly = yield* decodeMonthlyPayload(row.payload, stationCode, monthAt, "history")
    if (monthly.completeThrough < row.complete_through) {
      return yield* Effect.fail(archiveError(
        "history.stale",
        "Rollup archive payload is older than its D1 metadata"
      ))
    }
    return monthly
  })

  const loadLegacyMonthlyObject = Effect.fn("RollupArchive.loadLegacyMonthlyObject")(function*(
    stationCode: number,
    monthAt: number
  ) {
    if (legacyBucket === undefined) return null
    const object = yield* Effect.tryPromise({
      try: () => legacyBucket.get(rollupObjectKey(stationCode, monthAt)),
      catch: (cause) => archiveError("legacy.get", "Could not read legacy R2 rollup", cause)
    })
    if (object === null) return null
    const payload = yield* Effect.tryPromise({
      try: () => object.arrayBuffer(),
      catch: (cause) => archiveError("legacy.read", "Could not read legacy R2 rollup body", cause)
    })
    const monthly = yield* decodeMonthlyPayload(payload, stationCode, monthAt, "legacy")
    return { monthly, etag: object.etag, payload }
  })

  const buildMonthlyArchive = Effect.fn("RollupArchive.buildMonthlyArchive")(function*(
    block: typeof DailyRollupBlock.Type
  ) {
    const monthAt = utcMonthStart(block.dayAt)
    const stored = yield* loadMonthlyArchive(block.stationCode, monthAt)
    const legacy = stored === null
      ? yield* loadLegacyMonthlyObject(block.stationCode, monthAt)
      : null
    const current = stored ?? legacy?.monthly ?? null
    const from = block.dayAt
    const to = from + DAY_SECONDS
    const hourly = [
      ...(current?.hourly ?? []).filter((point) => point[0] < from || point[0] >= to),
      ...block.hourly
    ].sort((left, right) => left[0] - right[0])
    const monthly = MonthlyRollupObject.make({
      v: 1,
      stationCode: block.stationCode,
      monthAt,
      completeThrough: Math.max(current?.completeThrough ?? monthAt, block.dayAt + DAY_SECONDS),
      hourly
    })
    const text = yield* stringify(monthly, "history.serialize")
    const payload = yield* gzip(text)
    return { monthly, payload }
  })

  const complete = Effect.fn("RollupArchive.complete")(function*(
    job: typeof ArchiveJobRow.Type,
    archive: {
      readonly monthly: typeof MonthlyRollupObject.Type
      readonly payload: ArrayBuffer
    },
    now: number
  ) {
    yield* runBatch(db, [
      db.prepare(
        `INSERT INTO station_history_archives
           (station_code, month_at, complete_through, payload, updated_at)
         SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM station_rollup_archive_jobs
           WHERE day_at = ? AND station_code = ? AND last_attempt_at = ?
         )
         ON CONFLICT(station_code, month_at) DO UPDATE SET
           complete_through = excluded.complete_through,
           payload = excluded.payload,
           updated_at = excluded.updated_at
         WHERE excluded.complete_through >= station_history_archives.complete_through`
      ).bind(
        job.station_code,
        archive.monthly.monthAt,
        archive.monthly.completeThrough,
        archive.payload,
        now,
        job.day_at,
        job.station_code,
        job.last_attempt_at
      ),
      db.prepare(
        `DELETE FROM station_rollup_archive_jobs
         WHERE day_at = ? AND station_code = ? AND last_attempt_at = ?`
      ).bind(job.day_at, job.station_code, job.last_attempt_at),
      db.prepare(
        `UPDATE station_rollup_archive_days
         SET completed_at = ?
         WHERE day_at = ?
           AND NOT EXISTS (
             SELECT 1 FROM station_rollup_archive_jobs WHERE day_at = ?
           )`
      ).bind(now, job.day_at, job.day_at)
    ], "complete")
  })

  const prepareJobs = Effect.fn("RollupArchive.prepareJobs")(function*(now: number, limit: number) {
    const jobs = yield* claim(now, limit, false)
    let prepared = 0
    let failed = 0
    for (const job of jobs) {
      const outcome = yield* prepareOne(job, now).pipe(
        Effect.as(true),
        Effect.catch((error) => retry(job, now).pipe(
          Effect.andThen(Effect.logError("Rollup archive preparation failed", {
            dayAt: job.day_at,
            stationCode: job.station_code,
            operation: error.operation,
            detail: error.detail
          })),
          Effect.as(false)
        ))
      )
      if (outcome) prepared += 1
      else failed += 1
    }
    return { prepared, failed }
  })

  const deliverJobs = Effect.fn("RollupArchive.deliverJobs")(function*(now: number, limit: number) {
    const jobs = yield* claim(now, limit, true)
    let delivered = 0
    let failed = 0
    for (const job of jobs) {
      const outcome = yield* Effect.gen(function*() {
        if (job.payload === null) {
          return yield* Effect.fail(archiveError("deliver.payload", "Prepared archive payload is missing"))
        }
        const input = yield* parseJson(job.payload, "deliver.json")
        const block = yield* decode(DailyRollupBlock, input, "deliver.payload")
        if (block.dayAt !== job.day_at || block.stationCode !== job.station_code) {
          return yield* Effect.fail(archiveError("deliver.identity", "Prepared archive payload does not match its job"))
        }
        yield* validatePackedPoints(
          block.hourly,
          block.dayAt,
          block.dayAt + DAY_SECONDS,
          "deliver.timestamps"
        )
        const archive = yield* buildMonthlyArchive(block)
        yield* complete(job, archive, now)
      }).pipe(
        Effect.as(true),
        Effect.catch((error) => retry(job, now).pipe(
          Effect.andThen(Effect.logError("Rollup archive delivery failed", {
            dayAt: job.day_at,
            stationCode: job.station_code,
            operation: error.operation,
            detail: error.detail
          })),
          Effect.as(false)
        ))
      )
      if (outcome) delivered += 1
      else failed += 1
    }
    return { delivered, failed }
  })

  const backfillLegacyArchives = Effect.fn("RollupArchive.backfillLegacyArchives")(function*(
    now: number,
    limit: number
  ) {
    if (legacyBucket === undefined || limit === 0) return { backfilled: 0, failed: 0 }
    const rows = yield* allRows(
      db.prepare(
        `SELECT legacy.station_code, legacy.month_at, legacy.complete_through, legacy.etag
         FROM station_rollup_archive_objects AS legacy
         LEFT JOIN station_history_archives AS history
           ON history.station_code = legacy.station_code
          AND history.month_at = legacy.month_at
         WHERE history.station_code IS NULL
         ORDER BY legacy.month_at, legacy.station_code
         LIMIT ?`
      ).bind(limit),
      "backfill.discover"
    )
    const manifests = yield* decode(
      Schema.Array(LegacyArchiveObjectRow),
      rows,
      "backfill.discover"
    )
    const outcomes = yield* Effect.forEach(
      manifests,
      (manifest) => Effect.gen(function*() {
        const loaded = yield* loadLegacyMonthlyObject(manifest.station_code, manifest.month_at)
        if (loaded === null) {
          return yield* Effect.fail(archiveError(
            "backfill.missing",
            "Legacy R2 rollup is missing"
          ))
        }
        if (
          loaded.etag !== manifest.etag ||
          loaded.monthly.completeThrough < manifest.complete_through
        ) {
          return yield* Effect.fail(archiveError(
            "backfill.stale",
            "Legacy R2 rollup does not match its D1 manifest"
          ))
        }
        yield* runStatement(
          db.prepare(
            `INSERT INTO station_history_archives
               (station_code, month_at, complete_through, payload, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(station_code, month_at) DO NOTHING`
          ).bind(
            manifest.station_code,
            manifest.month_at,
            loaded.monthly.completeThrough,
            loaded.payload,
            now
          ),
          "backfill.save"
        )
      }).pipe(
        Effect.as(true),
        Effect.catch((error) => Effect.logError("Legacy rollup backfill failed", {
          stationCode: manifest.station_code,
          monthAt: manifest.month_at,
          operation: error.operation,
          detail: error.detail
        }).pipe(Effect.as(false)))
      ),
      { concurrency: 4 }
    )
    return {
      backfilled: outcomes.filter(Boolean).length,
      failed: outcomes.filter((outcome) => !outcome).length
    }
  })

  const maintain = Effect.fn("RollupArchive.maintain")(function*(
    now: number,
    options: {
      readonly prepareLimit?: number
      readonly deliveryLimit?: number
      readonly backfillLimit?: number
    } = {}
  ) {
    const enqueuedDays = yield* enqueueRecentDays(now)
    const preparation = yield* prepareJobs(now, options.prepareLimit ?? 25)
    const delivery = yield* deliverJobs(now, options.deliveryLimit ?? 8)
    const backfill = yield* backfillLegacyArchives(now, options.backfillLimit ?? 400)
    if (now % DAY_SECONDS === 15 * 60) {
      yield* runStatement(
        db.prepare("DELETE FROM station_history_archives WHERE month_at < ?").bind(
          utcMonthStart(now - ROLLUP_ARCHIVE_RETENTION_SECONDS)
        ),
        "history.prune"
      )
    }
    return {
      enqueuedDays,
      prepared: preparation.prepared,
      delivered: delivery.delivered,
      backfilled: backfill.backfilled,
      failed: preparation.failed + delivery.failed + backfill.failed
    }
  })

  const hourlyHistory = Effect.fn("RollupArchive.hourlyHistory")(function*(
    stationCode: number,
    range: ArchivedHistoryRange,
    now: number
  ) {
    const rangeSeconds = range === "30d" ? 30 * DAY_SECONDS : ROLLUP_ARCHIVE_RETENTION_SECONDS
    const from = now - rangeSeconds
    const requestedMonths = monthStartsBetween(from, now)
    const objects = yield* Effect.forEach(
      requestedMonths,
      (monthAt) => Effect.gen(function*() {
        const stored = yield* loadMonthlyArchive(stationCode, monthAt)
        if (stored !== null) return stored
        return (yield* loadLegacyMonthlyObject(stationCode, monthAt))?.monthly ?? null
      }),
      { concurrency: 4 }
    )
    const points = objects.flatMap((monthly) => monthly?.hourly.map(unpackPoint) ?? [])
    const unique = new Map<number, RollupHistoryPoint>()
    for (const point of points) {
      if (point.observedAt >= from && point.observedAt <= now) unique.set(point.observedAt, point)
    }
    return [...unique.values()].sort((left, right) => left.observedAt - right.observedAt)
  })

  return { maintain, hourlyHistory }
}

export const makeRollupArchiveLive = (db: D1Database, legacyBucket?: R2Bucket) =>
  Layer.succeed(RollupArchive, makeRollupArchive(db, legacyBucket))

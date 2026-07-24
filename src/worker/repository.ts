import { Context, Effect, Layer, Schema } from "effect"

import {
  decodeSnapshotText,
  decompressSnapshot,
  type EncodedSnapshot
} from "./codec"
import {
  Aggregate,
  CollectionRecord,
  CollectionStatus,
  CompactSnapshot,
  ExactHistoryPoint,
  HealthResponse,
  HealthRun,
  HistoryRange,
  HistoryResponse,
  LiveResponse,
  LiveStation,
  LiveUpdateEvent,
  LiveUpdateEventSchema,
  MINUTE_SECONDS,
  NetworkRollup,
  NotFoundError,
  PersistSnapshotResult,
  ReplayResponse,
  ReplayWindowMinutes,
  RepositoryError,
  RETENTION_SECONDS,
  ROLLUP_SECONDS,
  RollupHistoryPoint,
  SnapshotRecord,
  StationMetadata,
  StationResponse
} from "./domain"
import { deriveLiveUpdate } from "./live-update"
import { deriveReplay, deriveReplayFromUpdates } from "./replay"
import { deriveRollups } from "./rollup"

const MetadataRow = Schema.Struct({
  station_code: Schema.Number,
  station_id: Schema.String,
  name: Schema.String,
  latitude: Schema.Number,
  longitude: Schema.Number,
  capacity: Schema.Number,
  metadata_updated_at: Schema.Number
})

const StateValueRow = Schema.Struct({ value: Schema.Number })
const CompletionRow = Schema.Struct({ sample_count: Schema.Number })

const LatestHeaderRow = Schema.Struct({
  observed_at: Schema.Number,
  source_updated_at: Schema.Number
})
const LatestRow = Schema.Struct({
  observed_at: Schema.Number,
  source_updated_at: Schema.Number,
  payload: Schema.String
})

const SnapshotPayload = Schema.Union([
  Schema.Array(Schema.Number),
  Schema.Uint8Array,
  Schema.instanceOf(ArrayBuffer)
])
const SnapshotRow = Schema.Struct({
  observed_at: Schema.Number,
  source_updated_at: Schema.Number,
  payload: SnapshotPayload
})
const ReplayBaselineRow = Schema.Struct({
  observed_at: Schema.Number,
  source_updated_at: Schema.Number,
  payload: SnapshotPayload,
  end_observed_at: Schema.Number,
  end_source_updated_at: Schema.Number
})
const ReplayUpdateRow = Schema.Struct({
  observed_at: Schema.Number,
  previous_source_updated_at: Schema.Number,
  source_updated_at: Schema.Number,
  payload: Schema.String
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

const RunStatus = Schema.Literals(["ok", "stale", "error"])
const RunRow = Schema.Struct({
  observed_at: Schema.Number,
  source_updated_at: Schema.NullOr(Schema.Number),
  station_count: Schema.NullOr(Schema.Number),
  duration_ms: Schema.Number,
  status: RunStatus,
  message: Schema.NullOr(Schema.String)
})

const CountRow = Schema.Struct({ count: Schema.Number })
const RollupRepairRow = Schema.Struct({
  bucket_at: Schema.Number,
  snapshot_count: Schema.Number,
  completed_sample_count: Schema.NullOr(Schema.Number)
})

export class VelibRepository extends Context.Service<VelibRepository, {
  readonly hasMetadata: () => Effect.Effect<boolean, RepositoryError>
  readonly needsMetadata: (now: number) => Effect.Effect<boolean, RepositoryError>
  readonly syncMetadata: (
    stations: ReadonlyArray<StationMetadata>,
    syncedAt: number
  ) => Effect.Effect<void, RepositoryError>
  readonly persistSnapshot: (
    record: SnapshotRecord,
    encoded: EncodedSnapshot
  ) => Effect.Effect<PersistSnapshotResult, RepositoryError>
  readonly createRollups: (
    bucketAts: ReadonlyArray<number>
  ) => Effect.Effect<void, RepositoryError>
  readonly cleanup: (observedAt: number) => Effect.Effect<void, RepositoryError>
  readonly recordCollection: (record: CollectionRecord) => Effect.Effect<void, RepositoryError>
  readonly live: (now: number) => Effect.Effect<LiveResponse, RepositoryError | NotFoundError>
  readonly station: (code: number) => Effect.Effect<StationResponse, RepositoryError | NotFoundError>
  readonly history: (
    code: number,
    range: HistoryRange,
    now: number
  ) => Effect.Effect<HistoryResponse, RepositoryError | NotFoundError>
  readonly latestSourceUpdatedAt: () => Effect.Effect<number | null, RepositoryError>
  readonly replay: (
    minutes: ReplayWindowMinutes,
    now: number,
    at: number | null
  ) => Effect.Effect<ReplayResponse, RepositoryError | NotFoundError>
  readonly health: (now: number) => Effect.Effect<HealthResponse, RepositoryError>
}>()("velib/VelibRepository") {}

const repositoryError = (operation: string, cause: unknown): RepositoryError =>
  RepositoryError.make({
    operation,
    detail: `D1 operation failed: ${operation}`,
    cause
  })

const decodeError = (operation: string, cause: unknown): RepositoryError =>
  RepositoryError.make({
    operation,
    detail: `D1 returned invalid data for ${operation}`,
    cause
  })

const allRows = Effect.fn("VelibRepository.allRows")(function*(
  statement: D1PreparedStatement,
  operation: string
) {
  return yield* Effect.tryPromise({
    try: async () => (await statement.all<Record<string, unknown>>()).results,
    catch: (cause) => repositoryError(operation, cause)
  })
})

const firstRow = Effect.fn("VelibRepository.firstRow")(function*(
  statement: D1PreparedStatement,
  operation: string
) {
  return yield* Effect.tryPromise({
    try: async () => await statement.first<Record<string, unknown>>(),
    catch: (cause) => repositoryError(operation, cause)
  })
})

const runStatement = Effect.fn("VelibRepository.runStatement")(function*(
  statement: D1PreparedStatement,
  operation: string
) {
  yield* Effect.tryPromise({
    try: async () => {
      await statement.run()
    },
    catch: (cause) => repositoryError(operation, cause)
  })
})

const decodeRows = <S extends Schema.Top>(schema: S, input: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(input).pipe(
    Effect.mapError((cause) => decodeError(operation, cause))
  )

const stringify = Effect.fn("VelibRepository.stringify")(function*(value: unknown, operation: string) {
  return yield* Effect.try({
    try: () => {
      const json = JSON.stringify(value)
      if (json === undefined) {
        throw new Error("Value could not be serialized")
      }
      return json
    },
    catch: (cause) => repositoryError(operation, cause)
  })
})

const decodeLiveUpdatePayload = Effect.fn("VelibRepository.decodeLiveUpdatePayload")(function*(
  payload: string
) {
  const input = yield* Effect.try({
    try: (): unknown => JSON.parse(payload),
    catch: (cause) => decodeError("decodeLiveUpdatePayload.json", cause)
  })
  return yield* Schema.decodeUnknownEffect(LiveUpdateEventSchema)(input).pipe(
    Effect.mapError((cause) => decodeError("decodeLiveUpdatePayload.schema", cause))
  )
})

const metadataFromRow = (row: typeof MetadataRow.Type): StationMetadata =>
  StationMetadata.make({
    stationCode: row.station_code,
    stationId: row.station_id,
    name: row.name,
    latitude: row.latitude,
    longitude: row.longitude,
    capacity: row.capacity,
    metadataUpdatedAt: row.metadata_updated_at
  })

const makeRepository = (db: D1Database): VelibRepository["Service"] => {
  let latestCache: SnapshotRecord | null = null

  const loadMetadata = Effect.fn("VelibRepository.loadMetadata")(function*() {
    const rows = yield* allRows(
      db.prepare(
        "SELECT station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at FROM stations ORDER BY station_code"
      ),
      "loadMetadata"
    )
    const decoded = yield* decodeRows(Schema.Array(MetadataRow), rows, "loadMetadata")
    return decoded.map(metadataFromRow)
  })

  const loadMetadataStation = Effect.fn("VelibRepository.loadMetadataStation")(function*(code: number) {
    const row = yield* firstRow(
      db.prepare(
        "SELECT station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at FROM stations WHERE station_code = ?"
      ).bind(code),
      "loadMetadataStation"
    )
    if (row === null) {
      return yield* NotFoundError.make({ resource: `station:${code}` })
    }
    const decoded = yield* decodeRows(MetadataRow, row, "loadMetadataStation")
    return metadataFromRow(decoded)
  })

  const loadLatestHeader = Effect.fn("VelibRepository.loadLatestHeader")(function*() {
    const row = yield* firstRow(
      db.prepare("SELECT observed_at, source_updated_at FROM latest_status WHERE singleton = 1"),
      "loadLatestHeader"
    )
    if (row === null) return null
    return yield* decodeRows(LatestHeaderRow, row, "loadLatestHeader")
  })

  const loadLatest = Effect.fn("VelibRepository.loadLatest")(function*() {
    const row = yield* firstRow(
      db.prepare("SELECT observed_at, source_updated_at, payload FROM latest_status WHERE singleton = 1"),
      "loadLatest"
    )
    if (row === null) return null
    return yield* decodeRows(LatestRow, row, "loadLatest")
  })

  const loadLatestRecord = Effect.fn("VelibRepository.loadLatestRecord")(function*() {
    const header = yield* loadLatestHeader()
    if (header === null) {
      latestCache = null
      return null
    }
    if (
      latestCache !== null &&
      latestCache.observedAt === header.observed_at &&
      latestCache.sourceUpdatedAt === header.source_updated_at
    ) return latestCache

    const latest = yield* loadLatest()
    if (latest === null) {
      latestCache = null
      return null
    }
    const snapshot = yield* decodeSnapshotText(latest.payload).pipe(
      Effect.mapError((cause) => decodeError("decodePreviousLatest", cause))
    )
    latestCache = {
      observedAt: latest.observed_at,
      sourceUpdatedAt: latest.source_updated_at,
      snapshot
    }
    return latestCache
  })

  const runBatches = Effect.fn("VelibRepository.runBatches")(function*(
    statements: ReadonlyArray<D1PreparedStatement>,
    operation: string
  ) {
    for (let offset = 0; offset < statements.length; offset += 75) {
      const batch = statements.slice(offset, offset + 75)
      yield* Effect.tryPromise({
        try: async () => {
          await db.batch(batch)
        },
        catch: (cause) => repositoryError(operation, cause)
      })
    }
  })

  const hasMetadata = Effect.fn("VelibRepository.hasMetadata")(function*() {
    const row = yield* firstRow(
      db.prepare("SELECT 1 AS sample_count FROM stations LIMIT 1"),
      "hasMetadata"
    )
    if (row === null) return false
    yield* decodeRows(CompletionRow, row, "hasMetadata")
    return true
  })

  const needsMetadata = Effect.fn("VelibRepository.needsMetadata")(function*(now: number) {
    const row = yield* firstRow(
      db.prepare("SELECT value FROM system_state WHERE key = 'metadata_synced_at'"),
      "needsMetadata"
    )
    if (row === null) {
      return true
    }
    const state = yield* decodeRows(StateValueRow, row, "needsMetadata")
    return state.value < now - 86_400
  })

  const syncMetadata = Effect.fn("VelibRepository.syncMetadata")(function*(
    stations: ReadonlyArray<StationMetadata>,
    syncedAt: number
  ) {
    const statements: Array<D1PreparedStatement> = []
    for (let offset = 0; offset < stations.length; offset += 12) {
      const chunk = stations.slice(offset, offset + 12)
      const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?)").join(", ")
      const values: Array<string | number> = []
      for (const station of chunk) {
        values.push(
          station.stationCode,
          station.stationId,
          station.name,
          station.latitude,
          station.longitude,
          station.capacity,
          station.metadataUpdatedAt
        )
      }
      statements.push(
        db.prepare(
          `INSERT INTO stations (
             station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at
           ) VALUES ${placeholders}
           ON CONFLICT(station_code) DO UPDATE SET
             station_id = excluded.station_id,
             name = excluded.name,
             latitude = excluded.latitude,
             longitude = excluded.longitude,
             capacity = excluded.capacity,
             metadata_updated_at = excluded.metadata_updated_at`
        ).bind(...values)
      )
    }
    yield* runBatches(statements, "syncMetadata")
    yield* runStatement(
      db.prepare(
        `INSERT INTO system_state (key, value) VALUES ('metadata_synced_at', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(syncedAt),
      "syncMetadata.complete"
    )
  })

  const persistSnapshot = Effect.fn("VelibRepository.persistSnapshot")(function*(
    record: SnapshotRecord,
    encoded: EncodedSnapshot
  ) {
    const previous = yield* loadLatestRecord()
    const status: CollectionStatus = previous !== null && (
      record.observedAt <= previous.observedAt ||
      record.sourceUpdatedAt <= previous.sourceUpdatedAt
    ) ? "stale" : "ok"
    if (status === "stale") return { status, previous, liveUpdate: null }

    const liveUpdate = previous === null ? null : deriveLiveUpdate(previous, record)
    const liveUpdatePayload = liveUpdate === null
      ? null
      : yield* stringify(liveUpdate, "serializeLiveUpdate")
    const statements = [
      db.prepare(
        `INSERT OR IGNORE INTO minute_snapshots
           (observed_at, source_updated_at, station_count, payload)
         VALUES (?, ?, ?, ?)`
      ).bind(
        record.observedAt,
        record.sourceUpdatedAt,
        record.snapshot.s.length,
        encoded.compressed
      ),
      db.prepare(
        `INSERT INTO latest_status (singleton, observed_at, source_updated_at, payload)
         VALUES (1, ?, ?, ?)
         ON CONFLICT(singleton) DO UPDATE SET
           observed_at = excluded.observed_at,
           source_updated_at = excluded.source_updated_at,
           payload = excluded.payload
         WHERE excluded.observed_at > latest_status.observed_at
           AND excluded.source_updated_at > latest_status.source_updated_at`
      ).bind(record.observedAt, record.sourceUpdatedAt, encoded.text)
    ]
    if (liveUpdate !== null && liveUpdatePayload !== null) {
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO minute_updates
             (observed_at, previous_source_updated_at, source_updated_at, payload)
           VALUES (?, ?, ?, ?)`
        ).bind(
          liveUpdate.observedAt,
          liveUpdate.previousSourceUpdatedAt,
          liveUpdate.sourceUpdatedAt,
          liveUpdatePayload
        )
      )
    }
    yield* runBatches(statements, "persistSnapshot")

    latestCache = record
    return { status, previous, liveUpdate }
  })

  const loadSnapshots = Effect.fn("VelibRepository.loadSnapshots")(function*(from: number, to: number) {
    const rows = yield* allRows(
      db.prepare(
        `SELECT observed_at, source_updated_at, payload
         FROM minute_snapshots
         WHERE observed_at >= ? AND observed_at < ?
         ORDER BY observed_at`
      ).bind(from, to),
      "loadSnapshots"
    )
    const decoded = yield* decodeRows(Schema.Array(SnapshotRow), rows, "loadSnapshots")

    return yield* Effect.forEach(decoded, (row) =>
      Effect.map(decompressSnapshot(row.payload), (snapshot) => ({
        observedAt: row.observed_at,
        sourceUpdatedAt: row.source_updated_at,
        snapshot
      })).pipe(
        Effect.mapError((cause) => decodeError("loadSnapshots.payload", cause))
      )
    )
  })

  const loadReplayFromUpdates = Effect.fn("VelibRepository.loadReplayFromUpdates")(function*(
    anchor: number,
    minutes: ReplayWindowMinutes,
    now: number
  ) {
    const baselineInput = yield* firstRow(
      db.prepare(
        `WITH replay_end AS (
           SELECT observed_at, source_updated_at
           FROM minute_snapshots
           WHERE source_updated_at <= ?
           ORDER BY source_updated_at DESC, observed_at DESC
           LIMIT 1
         )
         SELECT
           baseline.observed_at,
           baseline.source_updated_at,
           baseline.payload,
           replay_end.observed_at AS end_observed_at,
           replay_end.source_updated_at AS end_source_updated_at
         FROM minute_snapshots AS baseline
         CROSS JOIN replay_end
         WHERE baseline.observed_at >= replay_end.observed_at - ?
           AND baseline.observed_at <= replay_end.observed_at
           AND baseline.source_updated_at <= replay_end.source_updated_at
         ORDER BY baseline.observed_at, baseline.source_updated_at
         LIMIT 1`
      ).bind(anchor, minutes * MINUTE_SECONDS),
      "loadReplayBaseline"
    )
    if (baselineInput === null) return null
    const row = yield* decodeRows(ReplayBaselineRow, baselineInput, "loadReplayBaseline")
    const snapshot = yield* decompressSnapshot(row.payload).pipe(
      Effect.mapError((cause) => decodeError("loadReplayBaseline.payload", cause))
    )
    const baseline: SnapshotRecord = {
      observedAt: row.observed_at,
      sourceUpdatedAt: row.source_updated_at,
      snapshot
    }
    const updateInput = yield* allRows(
      db.prepare(
        `SELECT observed_at, previous_source_updated_at, source_updated_at, payload
         FROM minute_updates
         WHERE observed_at > ? AND observed_at <= ?
           AND source_updated_at <= ?
         ORDER BY observed_at`
      ).bind(row.observed_at, row.end_observed_at, row.end_source_updated_at),
      "loadReplayUpdates"
    )
    const updateRows = yield* decodeRows(
      Schema.Array(ReplayUpdateRow),
      updateInput,
      "loadReplayUpdates"
    )
    const frames: Array<LiveUpdateEvent> = []
    for (const updateRow of updateRows) {
      const frame = yield* decodeLiveUpdatePayload(updateRow.payload)
      if (
        frame.observedAt !== updateRow.observed_at ||
        frame.previousSourceUpdatedAt !== updateRow.previous_source_updated_at ||
        frame.sourceUpdatedAt !== updateRow.source_updated_at
      ) return null
      frames.push(frame)
    }
    const response = deriveReplayFromUpdates(baseline, frames, minutes, now)
    const responseEndSourceUpdatedAt = response?.frames.at(-1)?.sourceUpdatedAt ??
      response?.baseline.sourceUpdatedAt
    return responseEndSourceUpdatedAt === row.end_source_updated_at ? response : null
  })

  const backfillReplayUpdates = Effect.fn("VelibRepository.backfillReplayUpdates")(function*(
    frames: ReadonlyArray<LiveUpdateEvent>
  ) {
    if (frames.length === 0) return
    const statements: Array<D1PreparedStatement> = []
    for (const frame of frames) {
      const payload = yield* stringify(frame, "serializeReplayBackfill")
      statements.push(
        db.prepare(
          `INSERT OR IGNORE INTO minute_updates
             (observed_at, previous_source_updated_at, source_updated_at, payload)
           VALUES (?, ?, ?, ?)`
        ).bind(
          frame.observedAt,
          frame.previousSourceUpdatedAt,
          frame.sourceUpdatedAt,
          payload
        )
      )
    }
    yield* runBatches(statements, "backfillReplayUpdates")
  })

  const loadRollupInputs = Effect.fn("VelibRepository.loadRollupInputs")(function*(
    bucketAt: number
  ) {
    const [snapshotRows = [], metadataRows = []] = yield* Effect.tryPromise({
      try: async () => {
        const results = await db.batch<Record<string, unknown>>([
          db.prepare(
            `SELECT observed_at, source_updated_at, payload
             FROM minute_snapshots
             WHERE observed_at >= ? AND observed_at < ?
             ORDER BY observed_at`
          ).bind(bucketAt, bucketAt + ROLLUP_SECONDS),
          db.prepare(
            `SELECT station_code, station_id, name, latitude, longitude, capacity, metadata_updated_at
             FROM stations
             ORDER BY station_code`
          )
        ])
        return results.map((result) => result.results)
      },
      catch: (cause) => repositoryError("loadRollupInputs", cause)
    })
    const decodedSnapshots = yield* decodeRows(
      Schema.Array(SnapshotRow),
      snapshotRows,
      "loadRollupInputs.snapshots"
    )
    const snapshots = yield* Effect.forEach(decodedSnapshots, (row) =>
      Effect.map(decompressSnapshot(row.payload), (snapshot) => ({
        observedAt: row.observed_at,
        sourceUpdatedAt: row.source_updated_at,
        snapshot
      })).pipe(
        Effect.mapError((cause) => decodeError("loadRollupInputs.payload", cause))
      )
    )
    const metadata = yield* decodeRows(
      Schema.Array(MetadataRow),
      metadataRows,
      "loadRollupInputs.metadata"
    )

    return { snapshots, metadata: metadata.map(metadataFromRow) }
  })

  const writeRollup = Effect.fn("VelibRepository.writeRollup")(function*(bucketAt: number) {
    const { snapshots, metadata } = yield* loadRollupInputs(bucketAt)
    if (snapshots.length === 0) {
      yield* runStatement(
        db.prepare(
          `INSERT INTO completed_rollups (bucket_at, completed_at, sample_count) VALUES (?, ?, 0)
           ON CONFLICT(bucket_at) DO UPDATE SET
             completed_at = excluded.completed_at,
             sample_count = excluded.sample_count`
        ).bind(bucketAt, bucketAt + ROLLUP_SECONDS),
        "createRollup.completeEmpty"
      )
      return
    }

    const rollups = deriveRollups(bucketAt, snapshots, metadata)
    const stationPayload = yield* stringify(
      rollups.stations.map((rollup) => [
        rollup.stationCode,
        rollup.bucketAt,
        rollup.sampleCount,
        rollup.mechanical.min,
        rollup.mechanical.max,
        rollup.mechanical.avg,
        rollup.mechanicalRemoved,
        rollup.mechanicalReturned,
        rollup.electric.min,
        rollup.electric.max,
        rollup.electric.avg,
        rollup.electricRemoved,
        rollup.electricReturned,
        rollup.docks.min,
        rollup.docks.max,
        rollup.docks.avg,
        rollup.unavailable.min,
        rollup.unavailable.max,
        rollup.unavailable.avg,
        rollup.operativeSamples
      ]),
      "serializeStationRollups"
    )
    const networkPayload = yield* stringify(rollups.network, "serializeNetworkRollup")

    // One JSON bind bypasses D1's 100-parameter limit. `WHERE true` disambiguates
    // SQLite's INSERT ... SELECT ... ON CONFLICT grammar.
    yield* runBatches(
      [
        db.prepare(
          `WITH input AS (SELECT value AS row FROM json_each(?))
           INSERT INTO station_rollups_5m (
             station_code, bucket_at, sample_count,
             mechanical_min, mechanical_max, mechanical_avg, mechanical_removed, mechanical_returned,
             electric_min, electric_max, electric_avg, electric_removed, electric_returned,
             docks_min, docks_max, docks_avg,
             unavailable_min, unavailable_max, unavailable_avg, operative_samples
           )
           SELECT
             json_extract(row, '$[0]'), json_extract(row, '$[1]'),
             json_extract(row, '$[2]'), json_extract(row, '$[3]'),
             json_extract(row, '$[4]'), json_extract(row, '$[5]'),
             json_extract(row, '$[6]'), json_extract(row, '$[7]'),
             json_extract(row, '$[8]'), json_extract(row, '$[9]'),
             json_extract(row, '$[10]'), json_extract(row, '$[11]'),
             json_extract(row, '$[12]'), json_extract(row, '$[13]'),
             json_extract(row, '$[14]'), json_extract(row, '$[15]'),
             json_extract(row, '$[16]'), json_extract(row, '$[17]'),
             json_extract(row, '$[18]'), json_extract(row, '$[19]')
           FROM input
           WHERE true
           ON CONFLICT(station_code, bucket_at) DO UPDATE SET
             sample_count = excluded.sample_count,
             mechanical_min = excluded.mechanical_min,
             mechanical_max = excluded.mechanical_max,
             mechanical_avg = excluded.mechanical_avg,
             mechanical_removed = excluded.mechanical_removed,
             mechanical_returned = excluded.mechanical_returned,
             electric_min = excluded.electric_min,
             electric_max = excluded.electric_max,
             electric_avg = excluded.electric_avg,
             electric_removed = excluded.electric_removed,
             electric_returned = excluded.electric_returned,
             docks_min = excluded.docks_min,
             docks_max = excluded.docks_max,
             docks_avg = excluded.docks_avg,
             unavailable_min = excluded.unavailable_min,
             unavailable_max = excluded.unavailable_max,
             unavailable_avg = excluded.unavailable_avg,
             operative_samples = excluded.operative_samples`
        ).bind(stationPayload),
        db.prepare(
          `INSERT INTO network_rollups_5m (bucket_at, payload) VALUES (?, ?)
           ON CONFLICT(bucket_at) DO UPDATE SET payload = excluded.payload`
        ).bind(bucketAt, networkPayload),
        db.prepare(
          `INSERT INTO completed_rollups (bucket_at, completed_at, sample_count) VALUES (?, ?, ?)
           ON CONFLICT(bucket_at) DO UPDATE SET
             completed_at = excluded.completed_at,
             sample_count = excluded.sample_count`
        ).bind(bucketAt, bucketAt + ROLLUP_SECONDS, snapshots.length)
      ],
      "writeRollup"
    )
  })

  const createRollups = Effect.fn("VelibRepository.createRollups")(function*(
    bucketAts: ReadonlyArray<number>
  ) {
    if (bucketAts.length === 0) return
    const requested = bucketAts.map(() => "(?)").join(", ")
    const rows = yield* allRows(
      db.prepare(
        `WITH requested(bucket_at) AS (VALUES ${requested}),
         snapshot_counts AS (
           SELECT requested.bucket_at, COUNT(snapshots.observed_at) AS snapshot_count
           FROM requested
           LEFT JOIN minute_snapshots AS snapshots
             ON snapshots.observed_at >= requested.bucket_at
            AND snapshots.observed_at < requested.bucket_at + ${ROLLUP_SECONDS}
           GROUP BY requested.bucket_at
         )
         SELECT snapshot_counts.bucket_at,
                snapshot_counts.snapshot_count,
                completed.sample_count AS completed_sample_count
         FROM snapshot_counts
         LEFT JOIN completed_rollups AS completed
           ON completed.bucket_at = snapshot_counts.bucket_at
         ORDER BY snapshot_counts.bucket_at DESC`
      ).bind(...bucketAts),
      "createRollups.discover"
    )
    const states = yield* decodeRows(
      Schema.Array(RollupRepairRow),
      rows,
      "createRollups.discover"
    )
    const pending = states.filter((state) =>
      state.completed_sample_count === null ||
      state.completed_sample_count < state.snapshot_count
    )
    yield* Effect.forEach(
      pending,
      (state) => writeRollup(state.bucket_at),
      { discard: true }
    )
  })

  const cleanup = Effect.fn("VelibRepository.cleanup")(function*(observedAt: number) {
    const cutoff = observedAt - RETENTION_SECONDS
    const cleanupSlot = Math.floor(observedAt / MINUTE_SECONDS) % 300
    const statements: Array<D1PreparedStatement> = [
      db.prepare("DELETE FROM minute_snapshots WHERE observed_at < ?").bind(cutoff),
      db.prepare("DELETE FROM minute_updates WHERE observed_at < ?").bind(cutoff),
      db.prepare("DELETE FROM collection_runs WHERE observed_at < ?").bind(cutoff),
      db.prepare("DELETE FROM network_rollups_5m WHERE bucket_at < ?").bind(cutoff),
      db.prepare("DELETE FROM completed_rollups WHERE bucket_at < ?").bind(cutoff),
      db.prepare(
        `DELETE FROM station_rollups_5m
         WHERE station_code IN (
           SELECT station_code FROM stations WHERE station_code % 300 = ?
         ) AND bucket_at < ?`
      ).bind(cleanupSlot, cutoff)
    ]

    if (observedAt % ROLLUP_SECONDS === 0) {
      const expiredBucket = observedAt - ROLLUP_SECONDS - RETENTION_SECONDS
      statements.push(
        db.prepare(
          `DELETE FROM station_rollups_5m
           WHERE station_code IN (SELECT station_code FROM stations)
             AND bucket_at = ?`
        ).bind(expiredBucket)
      )
    }
    yield* runBatches(statements, "cleanup")
  })

  const recordCollection = Effect.fn("VelibRepository.recordCollection")(function*(record: CollectionRecord) {
    yield* runStatement(
      db.prepare(
        `INSERT INTO collection_runs
           (observed_at, source_updated_at, station_count, duration_ms, status, message)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(observed_at) DO UPDATE SET
           source_updated_at = excluded.source_updated_at,
           station_count = excluded.station_count,
           duration_ms = excluded.duration_ms,
           status = excluded.status,
           message = excluded.message`
      ).bind(
        record.observedAt,
        record.sourceUpdatedAt,
        record.stationCount,
        record.durationMs,
        record.status,
        record.message
      ),
      "recordCollection"
    )
  })

  const buildLive = Effect.fn("VelibRepository.buildLive")(function*(now: number) {
    const latest = yield* loadLatest()
    if (latest === null) {
      return yield* NotFoundError.make({ resource: "live-status" })
    }
    const snapshot = yield* decodeSnapshotText(latest.payload).pipe(
      Effect.mapError((cause) => decodeError("decodeLatest", cause))
    )
    const metadata = yield* loadMetadata()
    const states = new Map(snapshot.s.map((station) => [station.c, station]))
    const stations: Array<LiveStation> = []

    let operativeStations = 0
    let mechanical = 0
    let electric = 0
    let docks = 0
    let unavailable = 0
    let emptyStations = 0
    let fullStations = 0

    for (const station of metadata) {
      const state = states.get(station.stationCode)
      if (state === undefined) {
        continue
      }
      const unavailableDocks = Math.max(0, station.capacity - state.m - state.e - state.d)
      const operative = state.o === 1
      stations.push({
        stationCode: station.stationCode,
        stationId: station.stationId,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        capacity: station.capacity,
        mechanical: state.m,
        electric: state.e,
        docks: state.d,
        unavailable: unavailableDocks,
        operative,
        lastReportedAt: state.r
      })

      operativeStations += state.o
      mechanical += state.m
      electric += state.e
      docks += state.d
      unavailable += unavailableDocks
      if (operative && state.m + state.e === 0) {
        emptyStations += 1
      }
      if (operative && state.d === 0) {
        fullStations += 1
      }
    }

    return {
      observedAt: latest.observed_at,
      sourceUpdatedAt: latest.source_updated_at,
      freshnessSeconds: Math.max(0, now - latest.source_updated_at),
      summary: {
        stations: stations.length,
        operativeStations,
        mechanical,
        electric,
        docks,
        unavailable,
        emptyStations,
        fullStations
      },
      stations
    }
  })

  const station = Effect.fn("VelibRepository.station")(function*(code: number) {
    const metadata = yield* loadMetadataStation(code)
    const latest = yield* loadLatest()
    if (latest === null) {
      return {
        station: metadata,
        status: null,
        observedAt: null,
        sourceUpdatedAt: null
      }
    }

    const snapshot = yield* decodeSnapshotText(latest.payload).pipe(
      Effect.mapError((cause) => decodeError("decodeLatest", cause))
    )
    const state = snapshot.s.find((candidate) => candidate.c === code)
    let status: LiveStation | null = null
    if (state !== undefined) {
      status = {
        stationCode: metadata.stationCode,
        stationId: metadata.stationId,
        name: metadata.name,
        latitude: metadata.latitude,
        longitude: metadata.longitude,
        capacity: metadata.capacity,
        mechanical: state.m,
        electric: state.e,
        docks: state.d,
        unavailable: Math.max(0, metadata.capacity - state.m - state.e - state.d),
        operative: state.o === 1,
        lastReportedAt: state.r
      }
    }

    return {
      station: metadata,
      status,
      observedAt: latest.observed_at,
      sourceUpdatedAt: latest.source_updated_at
    }
  })

  const history = Effect.fn("VelibRepository.history")(function*(
    code: number,
    range: HistoryRange,
    now: number
  ) {
    const metadata = yield* loadMetadataStation(code)
    if (range === "1h") {
      const snapshots = yield* loadSnapshots(now - 60 * 60, now + MINUTE_SECONDS)
      const points: Array<ExactHistoryPoint> = []
      for (const record of snapshots) {
        const state = record.snapshot.s.find((candidate) => candidate.c === code)
        if (state !== undefined) {
          points.push({
            observedAt: record.observedAt,
            mechanical: state.m,
            electric: state.e,
            docks: state.d,
            unavailable: Math.max(0, metadata.capacity - state.m - state.e - state.d),
            operative: state.o === 1
          })
        }
      }
      return {
        station: metadata,
        range,
        resolutionSeconds: MINUTE_SECONDS,
        points
      }
    }

    const rangeSeconds = range === "3h" ? 3 * 60 * 60 : range === "1d" ? 24 * 60 * 60 : RETENTION_SECONDS
    const rows = yield* allRows(
      db.prepare(
        `SELECT bucket_at, sample_count,
           mechanical_min, mechanical_max, mechanical_avg, mechanical_removed, mechanical_returned,
           electric_min, electric_max, electric_avg, electric_removed, electric_returned,
           docks_min, docks_max, docks_avg,
           unavailable_min, unavailable_max, unavailable_avg, operative_samples
         FROM station_rollups_5m
         WHERE station_code = ? AND bucket_at >= ?
         ORDER BY bucket_at`
      ).bind(code, now - rangeSeconds),
      "history.rollups"
    )
    const decoded = yield* decodeRows(Schema.Array(RollupRow), rows, "history.rollups")
    const points: Array<RollupHistoryPoint> = decoded.map((row) => ({
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
    }))

    return {
      station: metadata,
      range,
      resolutionSeconds: ROLLUP_SECONDS,
      points
    }
  })

  const latestSourceUpdatedAt = Effect.fn("VelibRepository.latestSourceUpdatedAt")(function*() {
    const latest = yield* loadLatestHeader()
    return latest?.source_updated_at ?? null
  })

  const replay = Effect.fn("VelibRepository.replay")(function*(
    minutes: ReplayWindowMinutes,
    now: number,
    at: number | null
  ) {
    const latest = yield* loadLatest()
    if (latest === null) {
      return yield* NotFoundError.make({ resource: "replay" })
    }

    const anchor = at ?? latest.source_updated_at
    const persistedReplay = yield* loadReplayFromUpdates(anchor, minutes, now)
    if (persistedReplay !== null) {
      yield* Effect.annotateCurrentSpan({
        minutes,
        frames: persistedReplay.frames.length,
        snapshots: 1,
        anchored: at !== null,
        replaySource: "updates"
      })
      return persistedReplay
    }

    const candidates = yield* loadSnapshots(
      anchor - minutes * MINUTE_SECONDS - 5 * MINUTE_SECONDS,
      anchor + 5 * MINUTE_SECONDS
    )
    const eligible = candidates.filter((snapshot) => snapshot.sourceUpdatedAt <= anchor)
    let end: SnapshotRecord | undefined
    for (const snapshot of eligible) {
      if (
        end === undefined ||
        snapshot.sourceUpdatedAt > end.sourceUpdatedAt ||
        snapshot.sourceUpdatedAt === end.sourceUpdatedAt && snapshot.observedAt > end.observedAt
      ) {
        end = snapshot
      }
    }
    if (end === undefined) {
      return yield* NotFoundError.make({ resource: "replay" })
    }
    const snapshots = eligible.filter((snapshot) =>
      snapshot.observedAt >= end.observedAt - minutes * MINUTE_SECONDS &&
      snapshot.observedAt <= end.observedAt
    )
    const response = deriveReplay(snapshots, minutes, now)
    if (response === null) {
      return yield* NotFoundError.make({ resource: "replay" })
    }
    yield* backfillReplayUpdates(response.frames)
    yield* Effect.annotateCurrentSpan({
      minutes,
      frames: response.frames.length,
      snapshots: snapshots.length,
      anchored: at !== null,
      replaySource: "snapshots"
    })
    return response
  })

  const health = Effect.fn("VelibRepository.health")(function*(now: number) {
    const latest = yield* loadLatest()
    const countInput = yield* firstRow(
      db.prepare("SELECT COUNT(*) AS count FROM minute_snapshots"),
      "health.snapshotCount"
    )
    const count = countInput === null
      ? 0
      : (yield* decodeRows(CountRow, countInput, "health.snapshotCount")).count
    const runInput = yield* allRows(
      db.prepare(
        `SELECT observed_at, source_updated_at, station_count, duration_ms, status, message
         FROM collection_runs ORDER BY observed_at DESC LIMIT 10`
      ),
      "health.runs"
    )
    const runRows = yield* decodeRows(Schema.Array(RunRow), runInput, "health.runs")
    const recentRuns: Array<HealthRun> = runRows.map((row) => ({
      observedAt: row.observed_at,
      sourceUpdatedAt: row.source_updated_at,
      stationCount: row.station_count,
      durationMs: row.duration_ms,
      status: row.status,
      message: row.message
    }))

    const freshness = latest === null ? null : Math.max(0, now - latest.source_updated_at)
    let status: HealthResponse["status"] = "ok"
    if (latest === null) {
      status = "empty"
    } else if (freshness !== null && freshness > 180) {
      status = "degraded"
    } else if (recentRuns[0]?.status === "error" || recentRuns[0]?.status === "stale") {
      status = "degraded"
    }

    return {
      status,
      now,
      latestObservedAt: latest?.observed_at ?? null,
      latestSourceUpdatedAt: latest?.source_updated_at ?? null,
      freshnessSeconds: freshness,
      retainedSnapshots: count,
      recentRuns
    }
  })

  return {
    hasMetadata,
    needsMetadata,
    syncMetadata,
    persistSnapshot,
    createRollups,
    cleanup,
    recordCollection,
    live: buildLive,
    station,
    history,
    latestSourceUpdatedAt,
    replay,
    health
  }
}

export const makeVelibRepositoryLive = (db: D1Database) =>
  Layer.succeed(VelibRepository, makeRepository(db))

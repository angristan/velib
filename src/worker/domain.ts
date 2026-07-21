import { Schema } from "effect"

export const RETENTION_SECONDS = 7 * 24 * 60 * 60
export const ROLLUP_SECONDS = 5 * 60
export const MINUTE_SECONDS = 60

const StationIdentifier = Schema.Union([Schema.String, Schema.Int])
const GbfsFlag = Schema.Union([Schema.Boolean, Schema.Literals([0, 1])])
const StationCode = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 999_999 })
)
const NonNegativeCount = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 10_000 })
)
const NonNegativeTimestamp = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
)
const PositiveTimestamp = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })
)
const Latitude = Schema.Number.check(
  Schema.isBetween({ minimum: -90, maximum: 90 })
)
const Longitude = Schema.Number.check(
  Schema.isBetween({ minimum: -180, maximum: 180 })
)

export class GbfsBikeType extends Schema.Class<GbfsBikeType>("GbfsBikeType")({
  mechanical: Schema.optionalKey(NonNegativeCount),
  ebike: Schema.optionalKey(NonNegativeCount)
}) {}

export class GbfsStatusStation extends Schema.Class<GbfsStatusStation>("GbfsStatusStation")({
  station_id: StationIdentifier,
  stationCode: Schema.String,
  num_bikes_available_types: Schema.Array(GbfsBikeType),
  num_docks_available: NonNegativeCount,
  is_installed: GbfsFlag,
  is_returning: GbfsFlag,
  is_renting: GbfsFlag,
  last_reported: NonNegativeTimestamp
}) {}

export class GbfsStatusData extends Schema.Class<GbfsStatusData>("GbfsStatusData")({
  stations: Schema.Array(GbfsStatusStation)
}) {}

export class GbfsStatusFeed extends Schema.Class<GbfsStatusFeed>("GbfsStatusFeed")({
  lastUpdatedOther: PositiveTimestamp,
  ttl: NonNegativeCount,
  data: GbfsStatusData
}) {}

export class GbfsInformationStation extends Schema.Class<GbfsInformationStation>("GbfsInformationStation")({
  station_id: StationIdentifier,
  stationCode: Schema.String,
  name: Schema.String,
  lat: Latitude,
  lon: Longitude,
  capacity: NonNegativeCount
}) {}

export class GbfsInformationData extends Schema.Class<GbfsInformationData>("GbfsInformationData")({
  stations: Schema.Array(GbfsInformationStation)
}) {}

export class GbfsInformationFeed extends Schema.Class<GbfsInformationFeed>("GbfsInformationFeed")({
  lastUpdatedOther: PositiveTimestamp,
  ttl: NonNegativeCount,
  data: GbfsInformationData
}) {}

export class StationMetadata extends Schema.Class<StationMetadata>("StationMetadata")({
  stationCode: StationCode,
  stationId: Schema.String,
  name: Schema.String,
  latitude: Latitude,
  longitude: Longitude,
  capacity: NonNegativeCount,
  metadataUpdatedAt: PositiveTimestamp
}) {}

/** Short field names materially reduce every stored full-network snapshot. */
export class CompactStation extends Schema.Class<CompactStation>("CompactStation")({
  c: StationCode,
  m: NonNegativeCount,
  e: NonNegativeCount,
  d: NonNegativeCount,
  o: Schema.Literals([0, 1]),
  r: NonNegativeTimestamp
}) {}

export class CompactSnapshot extends Schema.Class<CompactSnapshot>("CompactSnapshot")({
  v: Schema.Literal(1),
  s: Schema.Array(CompactStation)
}) {}

const LiveStationCode = StationCode
const LiveCount = NonNegativeCount
const LiveDelta = Schema.Int.check(
  Schema.isBetween({ minimum: -10_000, maximum: 10_000 })
)
const LiveTimestamp = PositiveTimestamp

export class LiveStationChange extends Schema.Class<LiveStationChange>("LiveStationChange")({
  c: LiveStationCode,
  m: LiveCount,
  e: LiveCount,
  d: LiveCount,
  o: Schema.Literals([0, 1]),
  dm: LiveDelta,
  de: LiveDelta,
  dd: LiveDelta
}) {}

export class LiveUpdateEvent extends Schema.Class<LiveUpdateEvent>("LiveUpdateEvent")({
  v: Schema.Literal(1),
  observedAt: LiveTimestamp,
  previousSourceUpdatedAt: LiveTimestamp,
  sourceUpdatedAt: LiveTimestamp,
  changes: Schema.Array(LiveStationChange)
}) {}

export class ReplayBaseline extends Schema.Class<ReplayBaseline>("ReplayBaseline")({
  observedAt: LiveTimestamp,
  sourceUpdatedAt: LiveTimestamp,
  stations: Schema.Array(CompactStation)
}) {}

export class ReplayResponse extends Schema.Class<ReplayResponse>("ReplayResponse")({
  v: Schema.Literal(1),
  minutes: Schema.Literals([15, 30, 60]),
  generatedAt: LiveTimestamp,
  from: LiveTimestamp,
  to: LiveTimestamp,
  baseline: ReplayBaseline,
  frames: Schema.Array(LiveUpdateEvent)
}) {}

export const LiveUpdateEventSchema = LiveUpdateEvent.check(
  Schema.makeFilter(
    (event) => event.sourceUpdatedAt > event.previousSourceUpdatedAt,
    { expected: "sourceUpdatedAt to advance" }
  )
)

export class Aggregate extends Schema.Class<Aggregate>("Aggregate")({
  min: Schema.Number,
  max: Schema.Number,
  avg: Schema.Number
}) {}

export class NetworkRollup extends Schema.Class<NetworkRollup>("NetworkRollup")({
  sampleCount: Schema.Number,
  mechanical: Aggregate,
  electric: Aggregate,
  docks: Aggregate,
  unavailable: Aggregate,
  operativeStations: Aggregate,
  emptyStations: Aggregate,
  fullStations: Aggregate
}) {}

export class FeedError extends Schema.TaggedErrorClass<FeedError>()("FeedError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class RepositoryError extends Schema.TaggedErrorClass<RepositoryError>()("RepositoryError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class CodecError extends Schema.TaggedErrorClass<CodecError>()("CodecError", {
  operation: Schema.String,
  detail: Schema.String,
  cause: Schema.optionalKey(Schema.Defect())
}) {}

export class RequestError extends Schema.TaggedErrorClass<RequestError>()("RequestError", {
  detail: Schema.String
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  resource: Schema.String
}) {}

export type AppError = FeedError | RepositoryError | CodecError | RequestError | NotFoundError
export type CollectionStatus = "ok" | "stale" | "error"
export type HistoryRange = "1h" | "3h" | "1d" | "7d"
export type ReplayWindowMinutes = 15 | 30 | 60

export interface CollectedStatus {
  readonly sourceUpdatedAt: number
  readonly stations: ReadonlyArray<CompactStation>
}

export interface SnapshotRecord {
  readonly observedAt: number
  readonly sourceUpdatedAt: number
  readonly snapshot: CompactSnapshot
}

export interface PersistSnapshotResult {
  readonly status: CollectionStatus
  readonly previous: SnapshotRecord | null
}

export interface CollectionRecord {
  readonly observedAt: number
  readonly sourceUpdatedAt: number | null
  readonly stationCount: number | null
  readonly durationMs: number
  readonly status: CollectionStatus
  readonly message: string | null
}

export interface ExactHistoryPoint {
  readonly observedAt: number
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
  readonly operative: boolean
}

export interface RollupHistoryPoint {
  readonly observedAt: number
  readonly sampleCount: number
  readonly mechanical: Aggregate
  readonly mechanicalRemoved: number
  readonly mechanicalReturned: number
  readonly electric: Aggregate
  readonly electricRemoved: number
  readonly electricReturned: number
  readonly docks: Aggregate
  readonly unavailable: Aggregate
  readonly operativeSamples: number
}

export interface StationRollup {
  readonly stationCode: number
  readonly bucketAt: number
  readonly sampleCount: number
  readonly mechanical: Aggregate
  readonly mechanicalRemoved: number
  readonly mechanicalReturned: number
  readonly electric: Aggregate
  readonly electricRemoved: number
  readonly electricReturned: number
  readonly docks: Aggregate
  readonly unavailable: Aggregate
  readonly operativeSamples: number
}

export interface LiveStation {
  readonly stationCode: number
  readonly stationId: string
  readonly name: string
  readonly latitude: number
  readonly longitude: number
  readonly capacity: number
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
  readonly operative: boolean
  readonly lastReportedAt: number
}

export interface LiveSummary {
  readonly stations: number
  readonly operativeStations: number
  readonly mechanical: number
  readonly electric: number
  readonly docks: number
  readonly unavailable: number
  readonly emptyStations: number
  readonly fullStations: number
}

export interface LiveResponse {
  readonly observedAt: number
  readonly sourceUpdatedAt: number
  readonly freshnessSeconds: number
  readonly summary: LiveSummary
  readonly stations: ReadonlyArray<LiveStation>
}

export interface StationResponse {
  readonly station: StationMetadata
  readonly status: LiveStation | null
  readonly observedAt: number | null
  readonly sourceUpdatedAt: number | null
}

export interface HistoryResponse {
  readonly station: StationMetadata
  readonly range: HistoryRange
  readonly resolutionSeconds: number
  readonly points: ReadonlyArray<ExactHistoryPoint | RollupHistoryPoint>
}

export interface HealthRun {
  readonly observedAt: number
  readonly sourceUpdatedAt: number | null
  readonly stationCount: number | null
  readonly durationMs: number
  readonly status: CollectionStatus
  readonly message: string | null
}

export interface HealthResponse {
  readonly status: "ok" | "degraded" | "empty"
  readonly now: number
  readonly latestObservedAt: number | null
  readonly latestSourceUpdatedAt: number | null
  readonly freshnessSeconds: number | null
  readonly retainedSnapshots: number
  readonly recentRuns: ReadonlyArray<HealthRun>
}

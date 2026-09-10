import { Data, Effect, Schema } from "effect"

import {
  Aggregate,
  type RollupHistoryPoint,
  type StationRollup
} from "./domain"

const MAX_COMPRESSED_BYTES = 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 4 * 1024 * 1024
export const ROLLUP_BUCKET_SHARDS = 16

export const rollupBucketShard = (stationCode: number): number =>
  ((stationCode % ROLLUP_BUCKET_SHARDS) + ROLLUP_BUCKET_SHARDS) % ROLLUP_BUCKET_SHARDS

const PackedStationRollup = Schema.Tuple([
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number,
  Schema.Number
])

const PackedStationRollupBucket = Schema.Tuple([
  Schema.Literal(1),
  Schema.Number,
  Schema.Array(PackedStationRollup)
])

export class RollupBucketError extends Data.TaggedError("RollupBucketError")<{
  readonly operation: string
  readonly cause: unknown
}> {}

const error = (operation: string, cause: unknown) =>
  new RollupBucketError({ operation, cause })

export const encodeRollupBucket = Effect.fn("RollupBucket.encode")(function*(
  bucketAt: number,
  rollups: ReadonlyArray<StationRollup>
) {
  const packed = [
    1,
    bucketAt,
    rollups.map((rollup) => [
      rollup.stationCode,
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
    ])
  ] as const
  const json = yield* Effect.try({
    try: () => JSON.stringify(packed),
    catch: (cause) => error("serialize", cause)
  })
  const payload = yield* Effect.tryPromise({
    try: async () => {
      const input = new Blob([new TextEncoder().encode(json)]).stream()
      return await new Response(input.pipeThrough(new CompressionStream("gzip"))).arrayBuffer()
    },
    catch: (cause) => error("compress", cause)
  })
  if (payload.byteLength > MAX_COMPRESSED_BYTES) {
    return yield* Effect.fail(error("size", new Error("Packed rollup bucket exceeds 1 MiB")))
  }
  return payload
})

const decompress = Effect.fn("RollupBucket.decompress")(function*(
  payload: ArrayBuffer | Uint8Array<ArrayBufferLike> | ReadonlyArray<number>
) {
  const byteLength = payload instanceof ArrayBuffer || payload instanceof Uint8Array
    ? payload.byteLength
    : payload.length
  if (byteLength > MAX_COMPRESSED_BYTES) {
    return yield* Effect.fail(error("size", new Error("Packed rollup bucket exceeds 1 MiB")))
  }
  return yield* Effect.tryPromise({
    try: async () => {
      const bytes = payload instanceof ArrayBuffer ? payload : Uint8Array.from(payload)
      const reader = new Blob([bytes]).stream()
        .pipeThrough(new DecompressionStream("gzip"))
        .getReader()
      const decoder = new TextDecoder()
      let size = 0
      let json = ""
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > MAX_DECOMPRESSED_BYTES) {
          await reader.cancel("Packed rollup bucket is too large")
          throw new Error("Packed rollup bucket exceeds 4 MiB after decompression")
        }
        json += decoder.decode(value, { stream: true })
      }
      return json + decoder.decode()
    },
    catch: (cause) => error("decompress", cause)
  })
})

export const decodeRollupBucket = Effect.fn("RollupBucket.decode")(function*(
  payload: ArrayBuffer | Uint8Array<ArrayBufferLike> | ReadonlyArray<number>
) {
  const json = yield* decompress(payload)
  const input = yield* Effect.try({
    try: (): unknown => JSON.parse(json),
    catch: (cause) => error("parse", cause)
  })
  return yield* Schema.decodeUnknownEffect(PackedStationRollupBucket)(input).pipe(
    Effect.mapError((cause) => error("schema", cause))
  )
})

export const stationPointFromBucket = (
  bucket: typeof PackedStationRollupBucket.Type,
  stationCode: number
): RollupHistoryPoint | null => {
  const point = bucket[2].find((candidate) => candidate[0] === stationCode)
  if (point === undefined) return null
  return {
    observedAt: bucket[1],
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
  }
}

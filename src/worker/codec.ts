import { Effect, Schema } from "effect"

import { CodecError, CompactSnapshot } from "./domain"

const encodeText = Effect.fn("SnapshotCodec.encodeText")(function*(snapshot: CompactSnapshot) {
  return yield* Effect.try({
    try: () => {
      const json = JSON.stringify(snapshot)
      if (json === undefined) {
        throw new Error("Snapshot could not be serialized")
      }
      return json
    },
    catch: (cause) =>
      CodecError.make({
        operation: "encodeText",
        detail: "Could not serialize the compact snapshot",
        cause
      })
  })
})

export const compressSnapshot = Effect.fn("SnapshotCodec.compress")(function*(snapshot: CompactSnapshot) {
  const json = yield* encodeText(snapshot)

  return yield* Effect.tryPromise({
    try: async () => {
      const input = new Blob([new TextEncoder().encode(json)]).stream()
      const output = input.pipeThrough(new CompressionStream("gzip"))
      return await new Response(output).arrayBuffer()
    },
    catch: (cause) =>
      CodecError.make({
        operation: "compress",
        detail: "Could not gzip the compact snapshot",
        cause
      })
  })
})

export const decodeSnapshotText = Effect.fn("SnapshotCodec.decodeText")(function*(json: string) {
  const input = yield* Effect.try({
    try: (): unknown => JSON.parse(json),
    catch: (cause) =>
      CodecError.make({
        operation: "parseJson",
        detail: "Stored snapshot is not valid JSON",
        cause
      })
  })

  return yield* Schema.decodeUnknownEffect(CompactSnapshot)(input).pipe(
    Effect.mapError((cause) =>
      CodecError.make({
        operation: "decodeSnapshot",
        detail: cause.message,
        cause
      })
    )
  )
})

export const decompressSnapshot = Effect.fn("SnapshotCodec.decompress")(function*(
  payload: ArrayBuffer | Uint8Array<ArrayBufferLike> | ReadonlyArray<number>
) {
  const json = yield* Effect.tryPromise({
    try: async () => {
      const bytes = payload instanceof ArrayBuffer ? payload : Uint8Array.from(payload)
      const input = new Blob([bytes]).stream()
      const output = input.pipeThrough(new DecompressionStream("gzip"))
      return await new Response(output).text()
    },
    catch: (cause) =>
      CodecError.make({
        operation: "decompress",
        detail: "Could not decompress a stored snapshot",
        cause
      })
  })

  return yield* decodeSnapshotText(json)
})

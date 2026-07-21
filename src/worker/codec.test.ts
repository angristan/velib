import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { decodeSnapshotText, decompressSnapshot, encodeSnapshot } from "./codec"
import { CompactSnapshot, CompactStation } from "./domain"

it.effect("round-trips compressed snapshots", () =>
  Effect.gen(function*() {
    const original = CompactSnapshot.make({
      v: 1,
      s: [CompactStation.make({ c: 2009, m: 12, e: 7, d: 19, o: 1, r: 1_784_625_000 })]
    })

    const encoded = yield* encodeSnapshot(original)
    const decodedText = yield* decodeSnapshotText(encoded.text)
    const decodedCompressed = yield* decompressSnapshot(encoded.compressed)

    assert.isBelow(encoded.compressed.byteLength, 200)
    assert.deepEqual(decodedText, original)
    assert.deepEqual(decodedCompressed, original)
  })
)

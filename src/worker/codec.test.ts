import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { compressSnapshot, decompressSnapshot } from "./codec"
import { CompactSnapshot, CompactStation } from "./domain"

it.effect("round-trips compressed snapshots", () =>
  Effect.gen(function*() {
    const original = CompactSnapshot.make({
      v: 1,
      s: [CompactStation.make({ c: 2009, m: 12, e: 7, d: 19, o: 1, r: 1_784_625_000 })]
    })

    const compressed = yield* compressSnapshot(original)
    const decoded = yield* decompressSnapshot(compressed)

    assert.isBelow(compressed.byteLength, 200)
    assert.deepEqual(decoded, original)
  })
)

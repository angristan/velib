import { assert, it } from "@effect/vitest"

import { CompactSnapshot, SnapshotRecord } from "./domain"
import { deriveReplay } from "./replay"

const snapshot = (
  observedAt: number,
  sourceUpdatedAt: number,
  mechanical: number
): SnapshotRecord => ({
  observedAt,
  sourceUpdatedAt,
  snapshot: CompactSnapshot.make({
    v: 1,
    s: [{ c: 1001, m: mechanical, e: 2, d: 10 - mechanical, o: 1, r: sourceUpdatedAt }]
  })
})

it("builds sequential replay frames and drops stale source timestamps", () => {
  const replay = deriveReplay([
    snapshot(60, 58, 4),
    snapshot(120, 58, 4),
    snapshot(180, 178, 6),
    snapshot(240, 238, 5)
  ], 15, 300)

  assert.isNotNull(replay)
  assert.strictEqual(replay?.baseline.sourceUpdatedAt, 58)
  assert.strictEqual(replay?.frames.length, 2)
  assert.strictEqual(replay?.frames[0]?.previousSourceUpdatedAt, 58)
  assert.strictEqual(replay?.frames[0]?.sourceUpdatedAt, 178)
  assert.strictEqual(replay?.frames[0]?.changes[0]?.dm, 2)
  assert.strictEqual(replay?.frames[1]?.previousSourceUpdatedAt, 178)
  assert.strictEqual(replay?.frames[1]?.changes[0]?.dm, -1)
})

it("returns null without a baseline snapshot", () => {
  assert.isNull(deriveReplay([], 60, 300))
})

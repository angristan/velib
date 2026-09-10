import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { collectMinute } from "./application"
import {
  CompactStation,
  type SnapshotRecord
} from "./domain"
import { GbfsClient } from "./gbfs"
import { VelibRepository } from "./repository"

const unused = () => Effect.die("unused")

it.effect("persists successful snapshots and maintains D1 rollups", () => {
  const observedAt = 1_786_915_500
  const sourceUpdatedAt = observedAt - 20
  const station = CompactStation.make({
    c: 2009,
    m: 5,
    e: 2,
    d: 8,
    o: 1,
    r: sourceUpdatedAt
  })
  let rollupCalls = 0
  let persisted: SnapshotRecord | undefined

  return Effect.gen(function*() {
    const result = yield* collectMinute(observedAt)

    assert.strictEqual(rollupCalls, 1)
    assert.strictEqual(persisted?.observedAt, observedAt)
    assert.deepEqual(result, { liveUpdate: null })
  }).pipe(
    Effect.provideService(GbfsClient, {
      fetchInformation: unused,
      fetchStatus: () => Effect.succeed({
        sourceUpdatedAt,
        stations: [station]
      })
    }),
    Effect.provideService(VelibRepository, {
      cleanup: () => Effect.void,
      createRollups: () => {
        rollupCalls += 1
        return Effect.void
      },
      hasMetadata: unused,
      health: unused,
      history: unused,
      latestSourceUpdatedAt: unused,
      live: unused,
      metadata: unused,
      needsMetadata: () => Effect.succeed(false),
      persistSnapshot: (record) => {
        persisted = record
        return Effect.succeed({
          status: "ok" as const,
          previous: null,
          liveUpdate: null
        })
      },
      recordCollection: () => Effect.void,
      replay: unused,
      snapshot: unused,
      station: unused,
      syncMetadata: unused
    })
  )
})

it.effect("does not archive a stale source observation", () => {
  const observedAt = 1_786_915_500
  const station = CompactStation.make({ c: 2009, m: 5, e: 2, d: 8, o: 1, r: observedAt - 20 })

  return Effect.gen(function*() {
    const result = yield* collectMinute(observedAt)
    assert.deepEqual(result, { liveUpdate: null })
  }).pipe(
    Effect.provideService(GbfsClient, {
      fetchInformation: unused,
      fetchStatus: () => Effect.succeed({
        sourceUpdatedAt: observedAt - 20,
        stations: [station]
      })
    }),
    Effect.provideService(VelibRepository, {
      cleanup: () => Effect.void,
      createRollups: () => Effect.void,
      hasMetadata: unused,
      health: unused,
      history: unused,
      latestSourceUpdatedAt: unused,
      live: unused,
      metadata: unused,
      needsMetadata: () => Effect.succeed(false),
      persistSnapshot: () => Effect.succeed({
        status: "stale" as const,
        previous: null,
        liveUpdate: null
      }),
      recordCollection: () => Effect.void,
      replay: unused,
      snapshot: unused,
      station: unused,
      syncMetadata: unused
    })
  )
})

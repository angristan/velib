import { assert, it } from "@effect/vitest"

import { Aggregate, type RollupHistoryPoint } from "./domain"
import {
  aggregateRollupPoints,
  archiveRetryDelaySeconds,
  HOUR_SECONDS,
  rollupObjectKey,
  SIX_HOURS_SECONDS,
  utcDayStart,
  utcMonthStart
} from "./rollup-archive"

const point = (
  observedAt: number,
  sampleCount: number,
  average: number
): RollupHistoryPoint => ({
  observedAt,
  sampleCount,
  mechanical: Aggregate.make({ min: average - 1, max: average + 1, avg: average }),
  mechanicalRemoved: 1,
  mechanicalReturned: 2,
  electric: Aggregate.make({ min: 1, max: 3, avg: 2 }),
  electricRemoved: 1,
  electricReturned: 1,
  docks: Aggregate.make({ min: 8, max: 10, avg: 9 }),
  unavailable: Aggregate.make({ min: 0, max: 2, avg: 1 }),
  operativeSamples: sampleCount
})

it("aggregates rollups with sample-weighted averages and movement sums", () => {
  const bucketAt = 1_800_000_000
  const result = aggregateRollupPoints([
    point(bucketAt, 4, 2),
    point(bucketAt + 300, 2, 8)
  ], HOUR_SECONDS)

  assert.strictEqual(result.length, 1)
  assert.strictEqual(result[0]?.sampleCount, 6)
  assert.strictEqual(result[0]?.mechanical.min, 1)
  assert.strictEqual(result[0]?.mechanical.max, 9)
  assert.strictEqual(result[0]?.mechanical.avg, 4)
  assert.strictEqual(result[0]?.mechanicalRemoved, 2)
  assert.strictEqual(result[0]?.mechanicalReturned, 4)
  assert.strictEqual(result[0]?.operativeSamples, 6)
})

it("bounds one year of hourly points to six-hour chart points", () => {
  const from = 1_800_000_000
  const hourly = Array.from({ length: 365 * 24 }, (_, index) =>
    point(from + index * HOUR_SECONDS, 12, index % 20)
  )

  const result = aggregateRollupPoints(hourly, SIX_HOURS_SECONDS)

  assert.isAtMost(result.length, 1_461)
  assert.strictEqual(result.reduce((sum, value) => sum + value.sampleCount, 0), 365 * 24 * 12)
})

it("uses stable UTC day, month, and object keys", () => {
  const timestamp = Date.UTC(2028, 1, 29, 23, 45) / 1_000

  assert.strictEqual(utcDayStart(timestamp), Date.UTC(2028, 1, 29) / 1_000)
  assert.strictEqual(utcMonthStart(timestamp), Date.UTC(2028, 1, 1) / 1_000)
  assert.strictEqual(
    rollupObjectKey(2009, Date.UTC(2028, 1, 1) / 1_000),
    `rollups/v1/stations/2009/${Date.UTC(2028, 1, 1) / 1_000}.json.gz`
  )
})

it("caps archive retry backoff at fifteen minutes", () => {
  assert.strictEqual(archiveRetryDelaySeconds(1), 60)
  assert.strictEqual(archiveRetryDelaySeconds(2), 120)
  assert.strictEqual(archiveRetryDelaySeconds(5), 900)
  assert.strictEqual(archiveRetryDelaySeconds(50), 900)
})

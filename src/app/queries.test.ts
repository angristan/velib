import { assert, it } from "@effect/vitest"
import { vi } from "vitest"

import { createAppQueryClient } from "./query-client"
import {
  liveQueryOptions,
  stationHistoryQueryOptions,
  velibQueryKeys,
} from "./queries"

it("does not replace a live cache with an older snapshot", async () => {
  const client = createAppQueryClient()
  const newer = { observedAt: 120_000, sourceUpdatedAt: 118_000, stations: [] }
  const older = { observedAt: 60_000, sourceUpdatedAt: 58_000, stations: [] }
  const options = liveQueryOptions(() => Promise.resolve(older))

  try {
    await client.fetchQuery(options)
    client.setQueryData(options.queryKey, newer)
    await client.fetchQuery({ ...options, staleTime: 0 })
    assert.strictEqual(client.getQueryData(options.queryKey), newer)
  } finally {
    client.clear()
  }
})

it("caches station history by station and range", async () => {
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ points: [] }), {
      headers: { "Content-Type": "application/json" },
    }),
  )
  const client = createAppQueryClient()

  try {
    const options = stationHistoryQueryOptions("2009", "3h")
    await client.fetchQuery(options)
    await client.fetchQuery(options)

    assert.strictEqual(fetchMock.mock.calls.length, 1)
    assert.deepEqual(options.queryKey, velibQueryKeys.history("2009", "3h"))
  } finally {
    client.clear()
    fetchMock.mockRestore()
  }
})

it("propagates Query cancellation to the history transport", async () => {
  let resolveStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve
  })
  let transportAborted = false
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
    const signal = init?.signal
    resolveStarted?.()
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        transportAborted = true
        reject(signal.reason)
      }, { once: true })
    })
  })
  const client = createAppQueryClient()
  const options = stationHistoryQueryOptions("2009", "3h")
  const running = client.fetchQuery(options)

  try {
    await started
    await client.cancelQueries({ exact: true, queryKey: options.queryKey })
    let cancelled = false
    try {
      await running
    } catch {
      cancelled = true
    }

    assert.isTrue(cancelled)
    assert.isTrue(transportAborted)
  } finally {
    client.clear()
    fetchMock.mockRestore()
  }
})

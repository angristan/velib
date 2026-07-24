import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { testExports } from "./routes"

it("cancels a pending session body read when interrupted", async () => {
  let cancelled = false
  let resolveReading: (() => void) | undefined
  const reading = new Promise<void>((resolve) => {
    resolveReading = resolve
  })
  const body = new ReadableStream<Uint8Array>({
    cancel: () => {
      cancelled = true
    },
    pull: () => {
      resolveReading?.()
    },
  })
  const request = new Request("https://velib.example.test/api/session", {
    body,
    duplex: "half",
    method: "POST",
  } as RequestInit & { duplex: "half" })
  const controller = new AbortController()
  const running = Effect.runPromise(
    testExports.parseSessionVerification(request),
    { signal: controller.signal },
  )

  await reading
  controller.abort()
  let interrupted = false
  try {
    await running
  } catch {
    interrupted = true
  }

  assert.isTrue(interrupted)
  assert.isTrue(cancelled)
})

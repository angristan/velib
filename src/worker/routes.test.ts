import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import { AccessControl, TurnstileUnavailable } from "./access"
import { VelibRepository } from "./repository"
import { handleRequest, testExports } from "./routes"

it("returns 503 when human verification is unavailable", async () => {
  const request = new Request("https://velib.example.test/api/session", {
    body: JSON.stringify({ turnstileToken: "valid-token" }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  })
  const response = await Effect.runPromise(
    handleRequest(request).pipe(
      Effect.provideService(AccessControl, {
        authorize: () => Effect.succeed({ id: "test", expiresAt: Date.now() + 60_000 }),
        create: () => Effect.fail(TurnstileUnavailable.make({ cause: new Error("offline") })),
        status: () => Effect.succeed({ verified: false, turnstileSiteKey: "test-site-key" }),
      }),
      Effect.provideService(VelibRepository, {
        cleanup: () => Effect.die("unused"),
        createRollups: () => Effect.die("unused"),
        hasMetadata: () => Effect.die("unused"),
        health: () => Effect.die("unused"),
        history: () => Effect.die("unused"),
        latestSourceUpdatedAt: () => Effect.die("unused"),
        live: () => Effect.die("unused"),
        needsMetadata: () => Effect.die("unused"),
        persistSnapshot: () => Effect.die("unused"),
        recordCollection: () => Effect.die("unused"),
        replay: () => Effect.die("unused"),
        station: () => Effect.die("unused"),
        syncMetadata: () => Effect.die("unused"),
      }),
    ),
  )

  assert.strictEqual(response.status, 503)
  assert.deepEqual(await response.json(), {
    error: {
      code: "verification_unavailable",
      message: "Human verification is temporarily unavailable",
    },
  })
})

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

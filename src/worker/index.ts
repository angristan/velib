import { Cause, Effect, Layer, ManagedRuntime } from "effect"

import {
  AccessControl,
  makeAccessControlLive,
  RateLimitExceeded,
  VerificationRequired
} from "./access"
import { collectMinute } from "./application"
import { ArchiveOutboxStore, makeArchiveOutboxStoreLive } from "./archive-outbox"
import {
  drainStationObservationOutbox,
  type StationObservationOutbox,
  type StationObservationPipeline
} from "./archive"
import { GbfsClientLive } from "./gbfs"
import { LiveFeed } from "./live-feed"
import { makeVelibRepositoryLive } from "./repository"
import { makeRollupArchiveLive, RollupArchive } from "./rollup-archive"
import { handleRequest } from "./routes"
import { TieredStationHistoryLive } from "./station-history"
import { type SessionCryptoError } from "./signing"

export { LiveFeed }

interface AnalyticsBindings {
  readonly OBSERVATIONS?: StationObservationPipeline
}

type RuntimeEnv = Omit<Env, keyof AnalyticsBindings> & AnalyticsBindings

const makeRuntime = (env: RuntimeEnv) => {
  const repositoryLayer = makeVelibRepositoryLive(env.DB)
  const archiveOutboxLayer = makeArchiveOutboxStoreLive(env.DB)
  const rollupArchiveLayer = makeRollupArchiveLive(env.DB, env.HISTORY_ROLLUPS)
  const historyLayer = Layer.provide(
    TieredStationHistoryLive,
    Layer.merge(repositoryLayer, rollupArchiveLayer)
  )

  return ManagedRuntime.make(
    Layer.mergeAll(
      GbfsClientLive,
      repositoryLayer,
      archiveOutboxLayer,
      rollupArchiveLayer,
      historyLayer,
      makeAccessControlLive(env)
    )
  )
}

type AppRuntime = ReturnType<typeof makeRuntime>
const runtimes = new WeakMap<RuntimeEnv, AppRuntime>()

const runtimeFor = (env: RuntimeEnv): AppRuntime => {
  const cached = runtimes.get(env)
  if (cached !== undefined) {
    return cached
  }
  const runtime = makeRuntime(env)
  runtimes.set(env, runtime)
  return runtime
}

const queryContainsOnly = (url: URL, allowed: ReadonlySet<string>): boolean => {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length > 1) return false
  }
  return true
}

const cacheKeyFor = (request: Request, url: URL): string | null => {
  if (request.method !== "GET") return null

  const canonical = new URL(url)
  canonical.search = ""
  if (url.pathname === "/api/health" && url.search === "") return canonical.toString()
  if (url.pathname === "/api/live" && url.search === "") return canonical.toString()
  if (/^\/api\/stations\/[1-9]\d*$/.test(url.pathname) && url.search === "") {
    return canonical.toString()
  }
  if (/^\/api\/stations\/[1-9]\d*\/history$/.test(url.pathname)) {
    if (!queryContainsOnly(url, new Set(["range"]))) return null
    const range = url.searchParams.get("range") ?? "1h"
    if (
      range !== "1h" && range !== "3h" && range !== "1d" &&
      range !== "7d" && range !== "30d" && range !== "1y"
    ) return null
    canonical.searchParams.set("range", range)
    return canonical.toString()
  }
  return null
}

const accessErrorResponse = (
  status: number,
  code: string,
  message: string,
  retryAfter?: number
): Response => {
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  })
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter))
  return new Response(JSON.stringify({ error: { code, message } }), { status, headers })
}

const authorizeApiRequest = (request: Request) => {
  const pathname = new URL(request.url).pathname
  if (
    !pathname.startsWith("/api/") ||
    pathname === "/api/session" ||
    pathname === "/api/health"
  ) return Effect.succeed<Response | null>(null)

  return Effect.gen(function*() {
    const access = yield* AccessControl
    yield* access.authorize(request)
    return null
  }).pipe(
    Effect.catchTags({
      VerificationRequired: (error: VerificationRequired) =>
        Effect.succeed(accessErrorResponse(401, "verification_required", error.message)),
      RateLimitExceeded: (error: RateLimitExceeded) =>
        Effect.succeed(
          accessErrorResponse(429, "rate_limited", error.message, error.retryAfter)
        ),
      SessionCryptoError: (error: SessionCryptoError) =>
        Effect.logError("Session authorization failed", { cause: error.cause }).pipe(
          Effect.as(accessErrorResponse(500, "session_unavailable", "Session is temporarily unavailable"))
        )
    })
  )
}

const internalError = (): Response =>
  new Response(
    JSON.stringify({ error: { code: "internal_error", message: "Unexpected server error" } }),
    {
      status: 500,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      }
    }
  )

const makeStationObservationOutbox = (runtime: AppRuntime): StationObservationOutbox => ({
  claim: (now, limit, leaseUntil) => runtime.runPromise(
    Effect.flatMap(ArchiveOutboxStore, (outbox) => outbox.claim(now, limit, leaseUntil))
  ),
  complete: (observedAt) => runtime.runPromise(
    Effect.flatMap(ArchiveOutboxStore, (outbox) => outbox.complete(observedAt))
  ),
  retry: (observedAt, nextAttemptAt) => runtime.runPromise(
    Effect.flatMap(ArchiveOutboxStore, (outbox) => outbox.retry(observedAt, nextAttemptAt))
  ),
  release: (observedAts, nextAttemptAt) => runtime.runPromise(
    Effect.flatMap(ArchiveOutboxStore, (outbox) => outbox.release(observedAts, nextAttemptAt))
  )
})

const deliverArchives = async (
  runtime: AppRuntime,
  pipeline: StationObservationPipeline,
  now: number
): Promise<void> => {
  try {
    const result = await drainStationObservationOutbox(
      pipeline,
      makeStationObservationOutbox(runtime),
      now
    )
    for (const delivery of result.deliveries) {
      console.info("Station observations archived", delivery)
    }
    if (result.failed !== null) {
      console.error("Station observation archive failed", result.failed)
    }
  } catch (cause) {
    console.error("Station observation outbox failed", { cause })
  }
}

const maintainRollupArchive = async (
  runtime: AppRuntime,
  now: number
): Promise<void> => {
  try {
    const result = await runtime.runPromise(
      Effect.flatMap(RollupArchive, (archive) => archive.maintain(now))
    )
    if (result.enqueuedDays > 0 || result.prepared > 0 || result.delivered > 0 || result.failed > 0) {
      console.info("Station rollup archive maintained", result)
    }
  } catch (cause) {
    console.error("Station rollup archive failed", { cause })
  }
}

const worker: ExportedHandler<RuntimeEnv> = {
  async fetch(request, env, context) {
    const url = new URL(request.url)
    const authorization = await runtimeFor(env).runPromise(
      authorizeApiRequest(request),
      { signal: request.signal }
    )
    if (authorization !== null) return authorization

    if (url.pathname === "/api/live/socket") {
      return env.LIVE_FEED.getByName("network").fetch(request)
    }

    const cacheKey = cacheKeyFor(request, url)
    const cache = cacheKey === null ? undefined : await caches.open("velib-api")
    if (cache !== undefined && cacheKey !== null) {
      const cached = await cache.match(cacheKey)
      if (cached !== undefined) {
        return cached
      }
    }

    const program = handleRequest(request).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Unhandled API failure", { cause: Cause.pretty(cause) }).pipe(
          Effect.as(internalError())
        )
      )
    )
    const response = await runtimeFor(env).runPromise(program, { signal: request.signal })
    if (cache !== undefined && cacheKey !== null && response.ok) {
      context.waitUntil(cache.put(cacheKey, response.clone()))
    }
    return response
  },

  scheduled(controller, env, context) {
    const observedAt = Math.floor(controller.scheduledTime / 1000 / 60) * 60
    const program = collectMinute(observedAt).pipe(
      Effect.tapCause((cause) =>
        Effect.logError("Scheduled collection terminated", {
          observedAt,
          cause: Cause.pretty(cause)
        })
      )
    )
    const runtime = runtimeFor(env)
    const ingestion = runtime.runPromise(program).then(async (result) => {
      const deliveries: Array<Promise<void>> = []
      if (env.OBSERVATIONS !== undefined) {
        deliveries.push(deliverArchives(runtime, env.OBSERVATIONS, observedAt))
      }
      const liveUpdate = result.liveUpdate
      if (liveUpdate !== null) {
        deliveries.push((async () => {
          try {
            const delivered = await env.LIVE_FEED.getByName("network").broadcast(
              JSON.stringify(liveUpdate)
            )
            if (delivered > 0) {
              console.info("Live update broadcast", {
                sourceUpdatedAt: liveUpdate.sourceUpdatedAt,
                changes: liveUpdate.changes.length,
                delivered
              })
            }
          } catch (cause) {
            console.error("Live update broadcast failed", {
              sourceUpdatedAt: liveUpdate.sourceUpdatedAt,
              cause
            })
          }
        })())
      }
      await Promise.all(deliveries)
    })
    context.waitUntil(Promise.all([
      ingestion,
      maintainRollupArchive(runtime, observedAt)
    ]).then(() => undefined))
  }
}

export default worker

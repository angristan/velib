import { Effect } from "effect"

import {
  HistoryRange,
  MINUTE_SECONDS,
  ReplayWindowMinutes,
  RequestError,
  RETENTION_SECONDS,
} from "./domain"
import { VelibRepository } from "./repository"

const jsonResponse = (value: unknown, status = 200, cacheControl = "no-store"): Response =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": cacheControl
    }
  })

const errorResponse = (status: number, code: string, message: string): Response =>
  jsonResponse({ error: { code, message } }, status)

const validateSearchParams = Effect.fn("validateSearchParams")(function*(
  url: URL,
  allowed: ReadonlySet<string>
) {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      return yield* RequestError.make({ detail: `Unsupported query parameter: ${key}` })
    }
  }
  for (const key of allowed) {
    if (url.searchParams.getAll(key).length > 1) {
      return yield* RequestError.make({ detail: `Query parameter must not be repeated: ${key}` })
    }
  }
})

const noSearchParams = new Set<string>()
const liveSearchParams = new Set(["reconcile"])
const replaySearchParams = new Set(["minutes", "at"])
const historySearchParams = new Set(["range"])

const parseStationCode = Effect.fn("parseStationCode")(function*(value: string) {
  const code = Number(value)
  if (!Number.isSafeInteger(code) || code <= 0) {
    return yield* RequestError.make({ detail: "Station code must be a positive integer" })
  }
  return code
})

const parseRange = Effect.fn("parseHistoryRange")(function*(value: string | null) {
  const range = value ?? "1h"
  if (range !== "1h" && range !== "3h" && range !== "1d" && range !== "7d") {
    return yield* RequestError.make({ detail: "range must be one of 1h, 3h, 1d, or 7d" })
  }
  const parsed: HistoryRange = range
  return parsed
})

const parseReplayMinutes = Effect.fn("parseReplayMinutes")(function*(value: string | null) {
  const input = value ?? "15"
  let parsed: ReplayWindowMinutes
  if (input === "15") parsed = 15
  else if (input === "30") parsed = 30
  else if (input === "60") parsed = 60
  else return yield* RequestError.make({ detail: "minutes must be 15, 30, or 60" })
  return parsed
})

const parseReplayAt = Effect.fn("parseReplayAt")(function*(
  value: string | null,
  now: number
) {
  if (value === null) return null
  const at = Number(value)
  if (
    !Number.isSafeInteger(at) ||
    at < now - RETENTION_SECONDS ||
    at > now + MINUTE_SECONDS
  ) {
    return yield* RequestError.make({ detail: "at must be a retained Unix timestamp" })
  }
  return at
})

const routeRequest = Effect.fn("routeRequest")(function*(request: Request) {
  if (request.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "Only GET is supported")
  }

  const repository = yield* VelibRepository
  const url = new URL(request.url)
  const now = Math.floor(Date.now() / 1000)

  if (url.pathname === "/api/health") {
    yield* validateSearchParams(url, noSearchParams)
    return jsonResponse(yield* repository.health(now), 200, "public, max-age=30")
  }
  if (url.pathname === "/api/live") {
    yield* validateSearchParams(url, liveSearchParams)
    return jsonResponse(yield* repository.live(now), 200, "public, max-age=15")
  }
  if (url.pathname === "/api/replay") {
    yield* validateSearchParams(url, replaySearchParams)
    const minutes = yield* parseReplayMinutes(url.searchParams.get("minutes"))
    const at = yield* parseReplayAt(url.searchParams.get("at"), now)
    const cacheControl = at === null ? "public, max-age=30" : "public, max-age=300"
    return jsonResponse(yield* repository.replay(minutes, now, at), 200, cacheControl)
  }

  const parts = url.pathname.split("/").filter((part) => part.length > 0)
  if (parts.length >= 3 && parts[0] === "api" && parts[1] === "stations") {
    const code = yield* parseStationCode(parts[2])
    if (parts.length === 3) {
      yield* validateSearchParams(url, noSearchParams)
      return jsonResponse(yield* repository.station(code), 200, "public, max-age=15")
    }
    if (parts.length === 4 && parts[3] === "history") {
      yield* validateSearchParams(url, historySearchParams)
      const range = yield* parseRange(url.searchParams.get("range"))
      return jsonResponse(yield* repository.history(code, range, now), 200, "public, max-age=30")
    }
  }

  return errorResponse(404, "not_found", "API route not found")
})

export const handleRequest = (request: Request) =>
  routeRequest(request).pipe(
    Effect.catchTags({
      RequestError: (error) =>
        Effect.succeed(errorResponse(400, "invalid_request", error.detail)),
      NotFoundError: (error) =>
        Effect.succeed(errorResponse(404, "not_found", `${error.resource} was not found`)),
      RepositoryError: (error) =>
        Effect.logError("API repository failure", {
          operation: error.operation,
          detail: error.detail
        }).pipe(
          Effect.as(errorResponse(503, "storage_unavailable", "Data is temporarily unavailable"))
        )
    })
  )

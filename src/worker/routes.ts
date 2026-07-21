import { Effect, Schema } from "effect"

import {
  AccessControl,
  RateLimitExceeded,
  VerificationFailed
} from "./access"
import { type SessionCryptoError } from "./signing"
import {
  HistoryRange,
  MINUTE_SECONDS,
  ReplayWindowMinutes,
  RequestError,
  RETENTION_SECONDS,
} from "./domain"
import { VelibRepository } from "./repository"

const jsonResponse = (
  value: unknown,
  status = 200,
  cacheControl = "no-store",
  headers?: HeadersInit
): Response => {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("content-type", "application/json; charset=utf-8")
  responseHeaders.set("cache-control", cacheControl)
  return new Response(JSON.stringify(value), { status, headers: responseHeaders })
}

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

const SessionVerificationRequest = Schema.Struct({
  turnstileToken: Schema.String
})

class SessionBodyTooLarge extends Error {}

const readSessionJson = async (request: Request): Promise<unknown> => {
  if (request.body === null) throw new Error("Missing request body")
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const result = await reader.read()
    if (result.done) break
    length += result.value.byteLength
    if (length > 4_096) {
      await reader.cancel()
      throw new SessionBodyTooLarge("Session request is too large")
    }
    chunks.push(result.value)
  }

  const body = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return JSON.parse(new TextDecoder().decode(body))
}

const parseSessionVerification = Effect.fn("parseSessionVerification")(function*(
  request: Request
) {
  const contentLength = Number(request.headers.get("Content-Length") ?? "0")
  if (Number.isFinite(contentLength) && contentLength > 4_096) {
    return yield* RequestError.make({ detail: "Session request is too large" })
  }
  const input = yield* Effect.tryPromise({
    try: () => readSessionJson(request),
    catch: (cause) => RequestError.make({
      detail: cause instanceof SessionBodyTooLarge
        ? cause.message
        : "Session request must be valid JSON"
    })
  })
  return yield* Schema.decodeUnknownEffect(SessionVerificationRequest)(input).pipe(
    Effect.mapError(() => RequestError.make({ detail: "Turnstile token is required" }))
  )
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
  const url = new URL(request.url)
  if (url.pathname === "/api/session") {
    yield* validateSearchParams(url, noSearchParams)
    const access = yield* AccessControl
    if (request.method === "GET") {
      return jsonResponse(yield* access.status(request))
    }
    if (request.method === "POST") {
      const payload = yield* parseSessionVerification(request)
      const created = yield* access.create(request, payload.turnstileToken)
      return jsonResponse(
        { verified: true },
        200,
        "no-store",
        { "Set-Cookie": created.cookie }
      )
    }
    return errorResponse(405, "method_not_allowed", "Only GET and POST are supported")
  }

  if (request.method !== "GET") {
    return errorResponse(405, "method_not_allowed", "Only GET is supported")
  }

  const repository = yield* VelibRepository
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
        ),
      VerificationFailed: (error: VerificationFailed) =>
        Effect.succeed(errorResponse(403, "verification_failed", error.message)),
      RateLimitExceeded: (error: RateLimitExceeded) =>
        Effect.succeed(jsonResponse(
          { error: { code: "rate_limited", message: error.message } },
          429,
          "no-store",
          { "Retry-After": String(error.retryAfter) }
        )),
      SessionCryptoError: (error: SessionCryptoError) =>
        Effect.logError("Session cryptography failed", { cause: error.cause }).pipe(
          Effect.as(errorResponse(500, "session_unavailable", "Session is temporarily unavailable"))
        )
    })
  )

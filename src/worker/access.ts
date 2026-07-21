import { Clock, Context, Effect, Layer, Option, Schedule, Schema } from "effect"

import { signJson, type SessionCryptoError, verifyJson } from "./signing"

const TURNSTILE_VERIFY_ENDPOINT =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify"
const TURNSTILE_ACTION = "velib_access"
const PRODUCTION_COOKIE = "__Host-velib_session"
const LOCAL_COOKIE = "velib_session"
const RATE_LIMIT_RETRY_AFTER = 60
const TURNSTILE_RETRY_POLICY = Schedule.recurs(1)
const TURNSTILE_TIMEOUT_MS = 5_000
const TEST_SITE_KEY = "1x00000000000000000000AA"
const TEST_SECRET_KEY = "1x0000000000000000000000000000000AA"
const LOCAL_SIGNING_SECRET = "local-velib-session-signing-secret-only"

export interface AccessEnv {
  readonly API_RATE_LIMITER?: RateLimit
  readonly SESSION_RATE_LIMITER?: RateLimit
  readonly APP_ENV?: string
  readonly APP_ORIGIN?: string
  readonly TURNSTILE_SITE_KEY?: string
  readonly TURNSTILE_SECRET_KEY?: string
  readonly TURNSTILE_HOSTNAME?: string
  readonly SESSION_SIGNING_SECRET?: string
  readonly SESSION_TTL?: string
}

export interface SessionStatus {
  readonly verified: boolean
  readonly turnstileSiteKey: string
}

export interface VerifiedSession {
  readonly id: string
  readonly expiresAt: number
}

export interface CreatedSession {
  readonly session: VerifiedSession
  readonly cookie: string
}

export class VerificationRequired extends Schema.TaggedErrorClass<VerificationRequired>()(
  "VerificationRequired",
  { message: Schema.String }
) {}

export class VerificationFailed extends Schema.TaggedErrorClass<VerificationFailed>()(
  "VerificationFailed",
  { message: Schema.String }
) {}

export class RateLimitExceeded extends Schema.TaggedErrorClass<RateLimitExceeded>()(
  "RateLimitExceeded",
  { retryAfter: Schema.Number, message: Schema.String }
) {}

class TurnstileUnavailable extends Schema.TaggedErrorClass<TurnstileUnavailable>()(
  "TurnstileUnavailable",
  { cause: Schema.Defect() }
) {}

const EnvironmentSchema = Schema.Struct({
  APP_ENV: Schema.optionalKey(Schema.String),
  APP_ORIGIN: Schema.optionalKey(Schema.String),
  TURNSTILE_SITE_KEY: Schema.optionalKey(Schema.String),
  TURNSTILE_SECRET_KEY: Schema.optionalKey(Schema.String),
  TURNSTILE_HOSTNAME: Schema.optionalKey(Schema.String),
  SESSION_SIGNING_SECRET: Schema.optionalKey(Schema.String),
  SESSION_TTL: Schema.optionalKey(Schema.String)
})

const TurnstileResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  hostname: Schema.optionalKey(Schema.String),
  action: Schema.optionalKey(Schema.String),
  "error-codes": Schema.optionalKey(Schema.Array(Schema.String))
})

const SessionPayloadSchema = Schema.Struct({
  v: Schema.Literal(1),
  sid: Schema.String,
  issuedAt: Schema.Number,
  expiresAt: Schema.Number
})

const decodeSession = Schema.decodeUnknownOption(SessionPayloadSchema)

type AccessFailure = VerificationRequired | RateLimitExceeded | SessionCryptoError

export class AccessControl extends Context.Service<AccessControl, {
  readonly status: (
    request: Request
  ) => Effect.Effect<SessionStatus, SessionCryptoError>
  readonly create: (
    request: Request,
    token: string
  ) => Effect.Effect<
    CreatedSession,
    VerificationFailed | RateLimitExceeded | SessionCryptoError
  >
  readonly authorize: (
    request: Request
  ) => Effect.Effect<VerifiedSession, AccessFailure>
}>()("velib/AccessControl") {}

interface AccessConfig {
  readonly production: boolean
  readonly appOrigin: string
  readonly turnstileSiteKey: string
  readonly turnstileSecretKey: string
  readonly turnstileHostname: string
  readonly sessionSigningSecret: string
  readonly sessionTtl: number
}

const isSecureOrigin = (value: string): boolean => {
  try {
    const url = new URL(value)
    return url.protocol === "https:" && url.origin === value
  } catch {
    return false
  }
}

const parseDuration = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const match = value.trim().match(/^(\d+(?:\.\d+)?)(s|m|h|d)?$/)
  if (match === null) return fallback
  const amount = Number(match[1])
  if (!Number.isFinite(amount) || amount <= 0) return fallback
  const unit = match[2] ?? "s"
  if (unit === "m") return amount * 60
  if (unit === "h") return amount * 3_600
  if (unit === "d") return amount * 86_400
  return amount
}

const loadAccessConfig = Effect.fn("AccessControl.loadConfig")(function*(environment: unknown) {
  const decoded = yield* Schema.decodeUnknownEffect(EnvironmentSchema)(environment).pipe(
    Effect.orDie
  )
  const production = decoded.APP_ENV === "production"
  const appOrigin = decoded.APP_ORIGIN ?? ""
  const turnstileSecretKey = decoded.TURNSTILE_SECRET_KEY ??
    (production ? "" : TEST_SECRET_KEY)
  const sessionSigningSecret = decoded.SESSION_SIGNING_SECRET ??
    (production ? "" : LOCAL_SIGNING_SECRET)
  const turnstileHostname = decoded.TURNSTILE_HOSTNAME ?? ""
  const turnstileSiteKey = decoded.TURNSTILE_SITE_KEY ?? TEST_SITE_KEY

  if (
    production &&
    (
      turnstileSiteKey.length === 0 ||
      turnstileSecretKey.length === 0 ||
      turnstileHostname.length === 0 ||
      !isSecureOrigin(appOrigin) ||
      sessionSigningSecret.length < 32
    )
  ) {
    return yield* Effect.die(
      new Error("Production Turnstile, origin, and session secrets are required")
    )
  }

  return {
    production,
    appOrigin,
    turnstileSiteKey,
    turnstileSecretKey,
    turnstileHostname,
    sessionSigningSecret,
    sessionTtl: parseDuration(decoded.SESSION_TTL, 30 * 60)
  } satisfies AccessConfig
})

const randomSessionId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let output = ""
  for (const byte of bytes) output += byte.toString(16).padStart(2, "0")
  return output
}

const cookieName = (request: Request): string =>
  new URL(request.url).protocol === "https:" ? PRODUCTION_COOKIE : LOCAL_COOKIE

const cookieValue = (request: Request, name: string): Option.Option<string> => {
  const matches = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`))
    .map((part) => part.slice(name.length + 1))
  return matches.length === 1 && matches[0] !== undefined
    ? Option.some(matches[0])
    : Option.none()
}

const serializeCookie = (
  name: string,
  value: string,
  maxAge: number,
  secure: boolean
): string => [
  `${name}=${value}`,
  "Path=/",
  "HttpOnly",
  "SameSite=Strict",
  `Max-Age=${Math.max(1, Math.floor(maxAge))}`,
  ...(secure ? ["Secure"] : [])
].join("; ")

export const makeAccessControlLive = (
  env: AccessEnv,
  fetcher: typeof fetch = fetch
) => Layer.effect(AccessControl)(Effect.gen(function*() {
  const config = yield* loadAccessConfig(env)
  const rateLimiter = env.API_RATE_LIMITER
  const sessionRateLimiter = env.SESSION_RATE_LIMITER
  if (
    config.production &&
    (rateLimiter === undefined || sessionRateLimiter === undefined)
  ) {
    return yield* Effect.die(new Error("API and session rate limiter bindings are required"))
  }

  const read = Effect.fn("AccessControl.read")(function*(request: Request) {
    const value = cookieValue(request, cookieName(request))
    if (Option.isNone(value)) return Option.none<VerifiedSession>()
    const verified = yield* verifyJson(value.value, config.sessionSigningSecret)
    if (Option.isNone(verified)) return Option.none<VerifiedSession>()
    const decoded = decodeSession(verified.value)
    if (Option.isNone(decoded)) return Option.none<VerifiedSession>()
    const now = yield* Clock.currentTimeMillis
    if (decoded.value.expiresAt <= now) return Option.none<VerifiedSession>()
    return Option.some({
      id: decoded.value.sid,
      expiresAt: decoded.value.expiresAt
    })
  })

  const status = Effect.fn("AccessControl.status")(function*(request: Request) {
    const session = yield* read(request)
    return {
      verified: Option.isSome(session),
      turnstileSiteKey: config.turnstileSiteKey
    } satisfies SessionStatus
  })

  const verifyTurnstile = Effect.fn("AccessControl.verifyTurnstile")(function*(
    request: Request,
    token: string,
    idempotencyKey: string
  ) {
    const form = new URLSearchParams()
    form.set("secret", config.turnstileSecretKey)
    form.set("response", token)
    form.set("idempotency_key", idempotencyKey)
    const remoteIp = request.headers.get("CF-Connecting-IP")
    if (remoteIp !== null) form.set("remoteip", remoteIp)

    const input = yield* Effect.tryPromise({
      try: async (): Promise<unknown> => {
        const response = await fetcher(TURNSTILE_VERIFY_ENDPOINT, {
          method: "POST",
          body: form,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded"
          },
          signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS)
        })
        if (!response.ok) throw new Error(`Siteverify returned HTTP ${response.status}`)
        return response.json()
      },
      catch: (cause) => TurnstileUnavailable.make({ cause })
    })
    return yield* Schema.decodeUnknownEffect(TurnstileResponseSchema)(input).pipe(
      Effect.mapError((cause) => TurnstileUnavailable.make({ cause }))
    )
  })

  const create = Effect.fn("AccessControl.create")(function*(
    request: Request,
    token: string
  ) {
    if (
      config.appOrigin.length > 0 &&
      request.headers.get("Origin") !== config.appOrigin
    ) {
      return yield* VerificationFailed.make({ message: "Session origin is not allowed" })
    }
    if (token.length === 0 || token.length > 2_048) {
      return yield* VerificationFailed.make({ message: "Turnstile token is invalid" })
    }
    if (sessionRateLimiter !== undefined) {
      const exceeded = () => RateLimitExceeded.make({
        retryAfter: RATE_LIMIT_RETRY_AFTER,
        message: "Too many verification attempts"
      })
      const outcome = yield* Effect.tryPromise({
        try: () => sessionRateLimiter.limit({
          key: request.headers.get("CF-Connecting-IP") ?? "unknown"
        }),
        catch: exceeded
      })
      if (!outcome.success) return yield* exceeded()
    }

    const outcome = yield* verifyTurnstile(
      request,
      token,
      crypto.randomUUID()
    ).pipe(
      Effect.retry(TURNSTILE_RETRY_POLICY),
      Effect.mapError((error) => {
        console.warn("Turnstile Siteverify unavailable", {
          errorTag: error._tag
        })
        return VerificationFailed.make({ message: "Turnstile verification failed" })
      })
    )
    const actionMatches = outcome.action === TURNSTILE_ACTION
    const hostnameMatches = config.turnstileHostname.length === 0 ||
      outcome.hostname === config.turnstileHostname
    if (
      !outcome.success ||
      (config.production && (!actionMatches || !hostnameMatches))
    ) {
      console.warn("Turnstile verification rejected", {
        success: outcome.success,
        errorCodes: outcome["error-codes"] ?? [],
        actionMatches,
        hostnameMatches
      })
      return yield* VerificationFailed.make({
        message: "Turnstile verification was rejected"
      })
    }

    const now = yield* Clock.currentTimeMillis
    const expiresAt = now + config.sessionTtl * 1_000
    const session = {
      id: randomSessionId(),
      expiresAt
    } satisfies VerifiedSession
    const value = yield* signJson({
      v: 1,
      sid: session.id,
      issuedAt: now,
      expiresAt
    }, config.sessionSigningSecret)

    return {
      session,
      cookie: serializeCookie(
        cookieName(request),
        value,
        config.sessionTtl,
        new URL(request.url).protocol === "https:"
      )
    } satisfies CreatedSession
  })

  const authorize = Effect.fn("AccessControl.authorize")(function*(request: Request) {
    const session = yield* read(request)
    if (Option.isNone(session)) {
      return yield* VerificationRequired.make({
        message: "Human verification is required"
      })
    }
    if (rateLimiter === undefined) return session.value

    const exceeded = () => RateLimitExceeded.make({
      retryAfter: RATE_LIMIT_RETRY_AFTER,
      message: "Too many API requests"
    })
    const outcome = yield* Effect.tryPromise({
      try: () => rateLimiter.limit({ key: session.value.id }),
      catch: exceeded
    })
    if (!outcome.success) return yield* exceeded()
    return session.value
  })

  return { status, create, authorize }
}))

export const testExports = {
  cookieName,
  cookieValue,
  loadAccessConfig,
  serializeCookie
}

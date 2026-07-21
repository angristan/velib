import { assert, it } from "@effect/vitest"
import { Effect } from "effect"

import {
  AccessControl,
  type AccessEnv,
  makeAccessControlLive,
} from "./access"

const productionEnvironment = (
  rateLimiter: RateLimit,
  sessionRateLimiter: RateLimit,
): AccessEnv => ({
  API_RATE_LIMITER: rateLimiter,
  SESSION_RATE_LIMITER: sessionRateLimiter,
  APP_ENV: "production",
  APP_ORIGIN: "https://velib.example.test",
  TURNSTILE_SITE_KEY: "test-site-key",
  TURNSTILE_SECRET_KEY: "test-secret-key",
  TURNSTILE_HOSTNAME: "velib.example.test",
  SESSION_SIGNING_SECRET: "test-session-signing-secret-at-least-32-bytes",
  SESSION_TTL: "30m",
})

const allowingRateLimiter: RateLimit = {
  limit: () => Promise.resolve({ success: true }),
}

const denyingRateLimiter: RateLimit = {
  limit: () => Promise.resolve({ success: false }),
}

const validSiteverify: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
  success: true,
  action: "velib_access",
  hostname: "velib.example.test",
}), {
  headers: { "Content-Type": "application/json" },
}))

const request = (cookie?: string): Request => new Request(
  "https://velib.example.test/api/session",
  {
    method: "POST",
    headers: {
      Origin: "https://velib.example.test",
      ...(cookie === undefined ? {} : { Cookie: cookie }),
    },
  },
)

it.effect("creates and validates a signed Turnstile session", () =>
  Effect.gen(function*() {
    const access = yield* AccessControl
    const created = yield* access.create(request(), "valid-token")
    const cookie = created.cookie.split(";", 1)[0]
    assert.isDefined(cookie)

    const authenticated = request(cookie)
    const status = yield* access.status(authenticated)
    const session = yield* access.authorize(authenticated)

    assert.isTrue(status.verified)
    assert.strictEqual(status.turnstileSiteKey, "test-site-key")
    assert.strictEqual(session.id, created.session.id)
    assert.include(created.cookie, "HttpOnly")
    assert.include(created.cookie, "SameSite=Strict")
    assert.include(created.cookie, "Secure")
  }).pipe(
    Effect.provide(
      makeAccessControlLive(
        productionEnvironment(allowingRateLimiter, allowingRateLimiter),
        validSiteverify,
      ),
    ),
  ),
)

it.effect("rejects Turnstile tokens issued for another action", () => {
  const wrongAction: typeof fetch = () => Promise.resolve(new Response(JSON.stringify({
    success: true,
    action: "other_action",
    hostname: "velib.example.test",
  })))

  return Effect.gen(function*() {
    const access = yield* AccessControl
    const denied = yield* access.create(request(), "valid-token").pipe(Effect.flip)

    assert.strictEqual(denied._tag, "VerificationFailed")
  }).pipe(
    Effect.provide(
      makeAccessControlLive(
        productionEnvironment(allowingRateLimiter, allowingRateLimiter),
        wrongAction,
      ),
    ),
  )
})

it.effect("rate limits Turnstile verification attempts before Siteverify", () =>
  Effect.gen(function*() {
    const access = yield* AccessControl
    const denied = yield* access.create(request(), "valid-token").pipe(Effect.flip)

    assert.strictEqual(denied._tag, "RateLimitExceeded")
  }).pipe(
    Effect.provide(
      makeAccessControlLive(
        productionEnvironment(allowingRateLimiter, denyingRateLimiter),
        validSiteverify,
      ),
    ),
  ),
)

it.effect("rejects altered sessions and enforced rate limits", () =>
  Effect.gen(function*() {
    const allowing = yield* AccessControl
    const created = yield* allowing.create(request(), "valid-token")
    const cookie = created.cookie.split(";", 1)[0]
    assert.isDefined(cookie)

    const tampered = request(`${cookie}x`)
    assert.isFalse((yield* allowing.status(tampered)).verified)

    const denied = yield* AccessControl.pipe(
      Effect.flatMap((access) => access.authorize(request(cookie))),
      Effect.flip,
      Effect.provide(
        makeAccessControlLive(
          productionEnvironment(denyingRateLimiter, allowingRateLimiter),
          validSiteverify,
        ),
      ),
    )
    assert.strictEqual(denied._tag, "RateLimitExceeded")
    if (denied._tag === "RateLimitExceeded") {
      assert.strictEqual(denied.retryAfter, 60)
    }
  }).pipe(
    Effect.provide(
      makeAccessControlLive(
        productionEnvironment(allowingRateLimiter, allowingRateLimiter),
        validSiteverify,
      ),
    ),
  ),
)

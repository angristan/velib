import { Effect, Option, Schema } from "effect"

export class SessionCryptoError extends Schema.TaggedErrorClass<SessionCryptoError>()(
  "SessionCryptoError",
  { cause: Schema.Defect() }
) {}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const importKey = Effect.fn("SessionSigning.importKey")(function*(secret: string) {
  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
      ),
    catch: (cause) => SessionCryptoError.make({ cause })
  })
})

const sign = Effect.fn("SessionSigning.sign")(function*(value: string, secret: string) {
  const key = yield* importKey(secret)
  const signature = yield* Effect.tryPromise({
    try: () => crypto.subtle.sign("HMAC", key, encoder.encode(value)),
    catch: (cause) => SessionCryptoError.make({ cause })
  })
  return new Uint8Array(signature)
})

const verify = Effect.fn("SessionSigning.verify")(function*(
  value: string,
  signature: Uint8Array,
  secret: string
) {
  const key = yield* importKey(secret)
  return yield* Effect.tryPromise({
    try: () =>
      crypto.subtle.verify(
        "HMAC",
        key,
        Uint8Array.from(signature).buffer,
        encoder.encode(value)
      ),
    catch: (cause) => SessionCryptoError.make({ cause })
  })
})

const base64UrlEncode = (value: Uint8Array): string => {
  let binary = ""
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

const decodeBase64Url = (value: string): Option.Option<Uint8Array> =>
  Option.liftThrowable((encoded: string) => {
    const standard = encoded.replaceAll("-", "+").replaceAll("_", "/")
    const padded = standard.padEnd(
      standard.length + ((4 - standard.length % 4) % 4),
      "="
    )
    const binary = atob(padded)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  })(value)

export const signJson = Effect.fn("SessionSigning.signJson")(function*(
  payload: unknown,
  secret: string
) {
  const encodedPayload = base64UrlEncode(
    encoder.encode(JSON.stringify(payload))
  )
  const signature = yield* sign(encodedPayload, secret)
  return `${encodedPayload}.${base64UrlEncode(signature)}`
})

export const verifyJson = Effect.fn("SessionSigning.verifyJson")(function*(
  token: string,
  secret: string
) {
  const parts = token.split(".")
  const payload = parts[0]
  const signature = parts[1]
  if (
    parts.length !== 2 ||
    payload === undefined ||
    signature === undefined ||
    payload.length === 0 ||
    signature.length === 0
  ) return Option.none<unknown>()

  const decodedSignature = decodeBase64Url(signature)
  if (Option.isNone(decodedSignature)) return Option.none<unknown>()
  if (!(yield* verify(payload, decodedSignature.value, secret))) {
    return Option.none<unknown>()
  }

  const decodedPayload = decodeBase64Url(payload)
  if (Option.isNone(decodedPayload)) return Option.none<unknown>()
  return Option.liftThrowable(
    (value: string): unknown => JSON.parse(value)
  )(decoder.decode(decodedPayload.value))
})

import { assert, it } from "@effect/vitest"

import {
  readReplayCache,
  type ReplayResponseCache,
  replayCacheKey,
  writeReplayCache,
} from "./replay-cache"

it("keys replay entries by window and source timestamp", () => {
  const baseUrl = "https://velib.example/api/replay?minutes=15"
  const first = replayCacheKey(baseUrl, 15, 1_784_747_186)
  const nextWindow = replayCacheKey(baseUrl, 30, 1_784_747_186)
  const nextSource = replayCacheKey(baseUrl, 15, 1_784_747_247)

  assert.notStrictEqual(first, nextWindow)
  assert.notStrictEqual(first, nextSource)
  assert.include(first, "minutes=15")
  assert.include(first, "end=1784747186")
})

it("stores shared entries while preventing browser caching", async () => {
  let storedKey: string | undefined
  let storedResponse: Response | undefined
  const cache: ReplayResponseCache = {
    match: async (key) => key === storedKey ? storedResponse : undefined,
    put: async (key, response) => {
      storedKey = key
      storedResponse = response
    },
  }
  const key = replayCacheKey("https://velib.example/api/replay", 15, 1_784_747_186)
  const generated = new Response('{"frames":[]}', {
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  })

  await writeReplayCache(cache, key, generated)

  assert.strictEqual(storedKey, key)
  assert.strictEqual(storedResponse?.headers.get("cache-control"), "public, max-age=86400")
  const cached = await readReplayCache(cache, key)
  assert.isDefined(cached)
  assert.strictEqual(cached?.headers.get("cache-control"), "no-store")
  assert.strictEqual(await cached?.text(), '{"frames":[]}')
})

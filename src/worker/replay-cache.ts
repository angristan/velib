import type { ReplayWindowMinutes } from "./domain"

const CACHE_NAME = "velib-replay-v1"
const CACHE_TTL_SECONDS = 24 * 60 * 60

export interface ReplayResponseCache {
  readonly match: (key: string) => Promise<Response | undefined>
  readonly put: (key: string, response: Response) => Promise<void>
}

export const replayCacheKey = (
  requestUrl: string,
  minutes: ReplayWindowMinutes,
  endSourceUpdatedAt: number,
): string => {
  const key = new URL("/__velib_cache/replay/v1", requestUrl)
  key.searchParams.set("minutes", String(minutes))
  key.searchParams.set("end", String(endSourceUpdatedAt))
  return key.toString()
}

const responseWithCacheControl = (response: Response, cacheControl: string): Response => {
  const headers = new Headers(response.headers)
  headers.set("cache-control", cacheControl)
  headers.delete("age")
  headers.delete("cf-cache-status")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

export const replayResponseForBrowser = (response: Response): Response =>
  responseWithCacheControl(response, "no-store")

const replayResponseForCache = (response: Response): Response =>
  responseWithCacheControl(response, `public, max-age=${CACHE_TTL_SECONDS}`)

export const openReplayCache = async (): Promise<ReplayResponseCache | null> => {
  try {
    return await caches.open(CACHE_NAME)
  } catch (cause) {
    console.warn("Replay cache unavailable", { cause })
    return null
  }
}

export const readReplayCache = async (
  cache: ReplayResponseCache,
  key: string,
): Promise<Response | undefined> => {
  try {
    const response = await cache.match(key)
    return response === undefined ? undefined : replayResponseForBrowser(response)
  } catch (cause) {
    console.warn("Replay cache read failed", { cause })
    return undefined
  }
}

export const writeReplayCache = async (
  cache: ReplayResponseCache,
  key: string,
  response: Response,
): Promise<void> => {
  try {
    await cache.put(key, replayResponseForCache(response.clone()))
  } catch (cause) {
    console.warn("Replay cache write failed", { cause })
  }
}

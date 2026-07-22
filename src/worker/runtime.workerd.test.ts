import { env } from "cloudflare:workers"
import { describe, expect, it } from "vitest"

describe("Worker runtime bindings", () => {
  it("applies the real D1 migrations", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    ).all<{ name: string }>()

    expect(tables.results.map(({ name }) => name)).toContain("stations")
    expect(tables.results.map(({ name }) => name)).toContain("minute_snapshots")
  })

  it("runs the LiveFeed Durable Object in Workerd", async () => {
    const response = await env.LIVE_FEED.getByName("integration").fetch(
      new Request("http://localhost/live"),
    )

    expect(response.status).toBe(426)
    expect(await response.text()).toBe("WebSocket upgrade required")
  })
})

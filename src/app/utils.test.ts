import { describe, expect, it } from "vitest"

import { formatFreshness, formatFreshnessCompact } from "./utils"

describe("formatFreshness", () => {
  it("shows elapsed seconds during the first minute", () => {
    expect(formatFreshness(90_000, 102_400)).toBe("il y a 12 s")
  })

  it("keeps map status labels compact", () => {
    expect(formatFreshnessCompact(90_000, 102_400)).toBe("12 s")
    expect(formatFreshnessCompact(60_000, 180_000)).toBe("2 min")
  })
})

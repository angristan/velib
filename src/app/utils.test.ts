import { describe, expect, it } from "vitest"

import {
  formatArchiveDistance,
  formatArchiveDuration,
  formatDistance,
  formatFreshness,
  formatFreshnessCompact,
} from "./utils"

describe("formatFreshness", () => {
  it("shows elapsed seconds during the first minute", () => {
    expect(formatFreshness(90_000, 102_400)).toBe("il y a 12 s")
  })

  it("keeps map status labels compact", () => {
    expect(formatFreshnessCompact(90_000, 102_400)).toBe("12 s")
    expect(formatFreshnessCompact(60_000, 180_000)).toBe("2 min")
  })

  it("formats elapsed time and distances in English", () => {
    const latestAt = 10 * 24 * 60 * 60_000
    expect(formatFreshness(90_000, 102_400, "en")).toBe("12 sec ago")
    expect(formatArchiveDistance(latestAt - 90 * 60_000, latestAt, "en")).toBe("2 hr ago")
    expect(formatArchiveDuration(latestAt - 90 * 60_000, latestAt, "en")).toBe("1 hr 30 min")
    expect(formatDistance(1_250, "en")).toBe("1.3 km")
    expect(formatDistance(1_250, "fr")).toBe("1,3 km")
  })

  it("summarizes archive age and comparison duration", () => {
    const latestAt = 10 * 24 * 60 * 60_000
    expect(formatArchiveDistance(latestAt, latestAt)).toBe("Maintenant")
    expect(formatArchiveDistance(latestAt - 90 * 60_000, latestAt)).toBe("Il y a 2 h")
    expect(formatArchiveDuration(latestAt - 90 * 60_000, latestAt)).toBe("1 h 30")
    expect(formatArchiveDuration(latestAt - 2 * 24 * 60 * 60_000, latestAt)).toBe("2 j")
  })
})

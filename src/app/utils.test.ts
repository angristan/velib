import { describe, expect, it } from "vitest"

import { formatFreshness } from "./utils"

describe("formatFreshness", () => {
  it("shows elapsed seconds during the first minute", () => {
    expect(formatFreshness(90_000, 102_400)).toBe("il y a 12 s")
  })
})

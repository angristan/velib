import { assert, it } from "@effect/vitest"
import { themeChangeFor } from "./theme"

it("switches the map background with the application theme", () => {
  assert.deepEqual(themeChangeFor("dark"), {
    colorScheme: "dark",
    mapBackground: "dark",
  })
  assert.deepEqual(themeChangeFor("light"), {
    colorScheme: "light",
    mapBackground: "light",
  })
})

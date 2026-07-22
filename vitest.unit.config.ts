import { defineProject } from "vitest/config"

export default defineProject({
  test: {
    name: "unit",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.workerd.test.ts"],
  },
})

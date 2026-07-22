import path from "node:path"
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers"
import { defineProject } from "vitest/config"

process.env.SESSION_SIGNING_SECRET ??= "local-velib-session-signing-secret-only"
process.env.TURNSTILE_SECRET_KEY ??= "1x0000000000000000000000000000000AA"

export default defineProject(async () => {
  const migrations = await readD1Migrations(
    path.resolve(import.meta.dirname, "migrations"),
  )

  return {
    plugins: [
      cloudflareTest({
        miniflare: {
          bindings: {
            SESSION_SIGNING_SECRET: "local-velib-session-signing-secret-only",
            TEST_MIGRATIONS: migrations,
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
          },
        },
        wrangler: { configPath: "./wrangler.jsonc" },
      }),
    ],
    test: {
      name: "workerd",
      include: ["src/**/*.workerd.test.ts"],
      setupFiles: ["./src/worker/test/apply-migrations.ts"],
    },
  }
})

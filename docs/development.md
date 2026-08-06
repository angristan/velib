# Development

Vélib’ Pulse uses [Bun](https://bun.sh/) `1.3.9`, Vite, and Cloudflare’s local Workers runtime. Wrangler provides local D1, Durable Object, and test Turnstile bindings.

## First run

```bash
bun install
cp .dev.vars.example .dev.vars
bun run db:migrate:local
bun run dev --host 127.0.0.1
```

Open <http://127.0.0.1:5173>. A fresh local database has no station data. In another shell, trigger the scheduled collector once:

```bash
curl "http://127.0.0.1:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

The collector reads the official Vélib’ Métropole GBFS feeds. Refresh the interface after the collection succeeds.

`.dev.vars.example` contains Cloudflare’s official test-only Turnstile credentials and a local signing secret. Never use these values in production.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Vite and Workers development server |
| `bun run check` | Run type checking, all tests, and the production build |
| `bun run test:unit` | Run application and Worker unit tests |
| `bun run test:workerd` | Run D1 and Durable Object integration tests in Workerd |
| `bun run cf-typegen` | Regenerate `worker-configuration.d.ts` from Wrangler configuration |
| `bun run cf-typegen:check` | Verify generated Worker bindings are current |
| `bun run db:migrate:local` | Apply D1 migrations to the local database |

CI also verifies the full migration sequence on a fresh local database and runs a Wrangler deployment dry run.

## Project structure

| Path | Contents |
| --- | --- |
| `src/app/` | React interface, map behavior, replay, and API client |
| `src/worker/` | Worker routes, collection, D1 repository, and Durable Object |
| `migrations/` | D1 schema migrations |
| `public/` | Static metadata and preview assets |
| `wrangler.jsonc` | Worker bindings, domain, cron, observability, and deployment configuration |

See [Architecture](architecture.md) for component responsibilities and data flows.

## Troubleshooting

### The map has no data

Apply migrations, start the server, and trigger the scheduled collector as shown above. Check the development server logs for upstream decoding or D1 errors.

### Generated bindings are stale

Regenerate and verify them after changing `wrangler.jsonc`:

```bash
bun run cf-typegen
bun run cf-typegen:check
```

### Workerd tests fail after a migration

The Workerd suite applies all migrations to isolated D1 storage. Ensure every migration works from an empty database and that `src/worker/test/apply-migrations.ts` still discovers them in order.

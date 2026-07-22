# Vélib’ Pulse

A map-first view of Vélib’ Métropole availability, live network changes, and seven days of station history.

[**Open Vélib’ Pulse →**](https://velib.stanislas.cloud)

![Vélib’ Pulse — live Vélib’ Métropole availability](public/og-preview.png)

Vélib’ Pulse is an independent, unofficial service. It is not affiliated with Vélib’ Métropole or Smovengo.

## Features

- Live availability for mechanical bikes, electric bikes, and open docks.
- Map and station search with filters, nearby stations, and station history.
- Live network updates over WebSockets without repeatedly downloading the full dataset.
- Replay of the last 15, 30, or 60 minutes at multiple playback speeds.
- A gain-and-loss heatmap and station-level availability streaks.
- Shareable URLs that preserve the camera, filters, selection, map layer, and replay time.
- Light and dark map themes with responsive desktop and mobile layouts.

## Quick start

The project uses [Bun](https://bun.sh/) `1.3.9`. Cloudflare’s local runtime, D1 database, Durable Object, and test Turnstile credentials are configured by the repository.

```bash
bun install
cp .dev.vars.example .dev.vars
bun run db:migrate:local
bun run dev
```

Open <http://localhost:5173>. The interface remains empty until the first successful collection. Trigger one through Wrangler’s local scheduled endpoint:

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

The values in `.dev.vars.example` include Cloudflare’s official test-only Turnstile credentials. Never use them in production.

## Development commands

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start the Vite and Workers development server |
| `bun run check` | Run type checking, all tests, and the production build |
| `bun run test:unit` | Run application and Worker unit tests |
| `bun run test:workerd` | Run D1 and Durable Object integration tests in Workerd |
| `bun run cf-typegen` | Regenerate `worker-configuration.d.ts` from Wrangler configuration |
| `bun run cf-typegen:check` | Verify generated Worker bindings are current |
| `bun run db:migrate:local` | Apply D1 migrations to the local database |

CI additionally verifies a fresh local migration sequence and a Wrangler deployment dry run.

## How it works

```text
Vélib’ GBFS ──▶ scheduled Worker ──▶ D1 snapshots and rollups
                         │
                         └──▶ LiveFeed Durable Object ──▶ WebSocket clients

Browser ──▶ Turnstile session ──▶ Worker API ──▶ D1
   └─────────────────────────────▶ LiveFeed WebSocket
```

A scheduled Worker collects the official GBFS feeds every minute. D1 stores the latest network state, compressed minute snapshots, and five-minute rollups. The Worker API serves initial state, replay data, and station history. A hibernating Durable Object broadcasts compact changes to connected browsers while D1 remains authoritative.

Effect provides boundary validation, typed failures, services, and request workflows. Workers Static Assets serves the React, Mantine, and MapLibre interface.

For the storage model, data paths, caching, and access controls, see [Architecture](docs/architecture.md). For production configuration, deployment, rollback, and D1 recovery, see [Operations](docs/operations.md).

## Project layout

| Path | Contents |
| --- | --- |
| `src/app/` | React interface, map behavior, replay, and API client |
| `src/worker/` | Worker routes, collection, D1 repository, and Durable Object |
| `migrations/` | D1 schema migrations |
| `public/` | Static metadata and preview assets |
| `wrangler.jsonc` | Worker bindings, domain, cron, observability, and deployment configuration |

## Deployment

Production uses a D1 database, a Durable Object, two Workers Rate Limiting bindings, Turnstile, Workers Static Assets, and the `velib.stanislas.cloud` custom domain. It also requires the `TURNSTILE_SECRET_KEY` and `SESSION_SIGNING_SECRET` Worker secrets.

Do not deploy code that requires a schema migration before applying that migration. Follow the [deployment checklist](docs/operations.md#deploy) rather than invoking Wrangler directly.

## Data and attribution

Availability and station metadata come from the [Vélib’ Métropole GBFS open-data feeds](https://www.velib-metropole.fr/donnees-open-data-gbfs-du-service-velib-metropole), published under the French [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/). The interface shows the effective source-update time. Map data is attributed in the interface by the configured basemap provider.

## License

The application source is available under the [MIT License](LICENSE). Source data remains subject to the Licence Ouverte and each basemap provider’s terms.

# Vélib Pulse

A fast, map-first view of Vélib' Métropole availability with seven days of local history. The application runs entirely on Cloudflare Workers and D1; collection starts at deployment and does not require a backfill.

**Live:** [velib.stanislas.cloud](https://velib.stanislas.cloud)

This is an independent, unofficial service and is not affiliated with Vélib’ Métropole or Smovengo.

## Architecture

```text
Vélib GBFS ── every minute ──▶ Cron Worker
                                  │
                  ┌───────────────┼─────────────────┐
                  ▼               ▼                 ▼
           latest status    gzip snapshots     5-minute rollups
                  │
                  ├──▶ Turnstile session + rate limit ──▶ Worker JSON API ──┐
                  │                                                          ▼
                  └── compact diff ──▶ LiveFeed Durable Object ── WebSockets
                                             ▲                                │
                                             └── verified session ─────────────┘
                                                                              ▼
                                                               React + Mantine + MapLibre
```

- **Effect** owns boundary decoding, typed failures, services, layers, ingestion, and request workflows.
- **D1 minute snapshots** retain compact, compressed source observations for seven days so rollups can be rebuilt.
- **D1 station rollups** make station graphs inexpensive without a write-heavy row-per-station-per-minute model.
- **LiveFeed Durable Object** broadcasts each compact network diff through hibernating WebSockets. D1 remains authoritative; the JSON API handles initial state and five-minute reconciliation.
- **Bounded replay API** reads at most about 70 candidate minute snapshots, returns at most 61 timeline snapshots as one compact baseline plus sequential sparse diffs, and is edge-cached for reuse.
- **Workers Static Assets** serves the interface; API responses carry cache directives for edge reuse.
- **Managed Turnstile** creates a signed, 30-minute HttpOnly session before data access. Workers Rate Limiting bindings allow approximately 60 API requests per minute per verified random session and 20 verification attempts per minute per client address and Cloudflare location. Health and session bootstrap remain public.

The interface can replay the latest 15, 30, or 60 minutes, switch to a gain/loss heatmap, show per-station streaks, and share a canonical URL containing the camera, filters, selection, layer, and replay timestamp. Live collection remains connected in the background while replay is frozen.

## Local development

```bash
bun install
cp .dev.vars.example .dev.vars
bun run db:migrate:local
bun run dev
```

The example environment uses Cloudflare's official test-only Turnstile keys. Never use them in production.

The first scheduled collection can be triggered locally through Wrangler's scheduled endpoint:

```bash
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

Until the first successful collection, the interface intentionally shows an empty state rather than demo data.

## Validation

```bash
bun run typecheck
bun run test
bun run build
```

## Deployment

The production D1 binding, Turnstile site key, native rate limiter, and `velib.stanislas.cloud` custom domain are declared in `wrangler.jsonc`. Production additionally requires the `TURNSTILE_SECRET_KEY` and `SESSION_SIGNING_SECRET` Worker secrets. Apply any pending migrations before deploying:

```bash
bun run db:migrate:remote
bun run deploy
```

The collector runs every minute. Retention combines cheap exact-key cleanup with bounded recovery passes, avoiding a write-heavy secondary timestamp index. The `LiveFeed` SQLite-class migration is applied by the Worker deployment.

## Data and attribution

Availability and station metadata come from the [Vélib' Métropole GBFS open-data feeds](https://www.velib-metropole.fr/donnees-open-data-gbfs-du-service-velib-metropole), published under the French [Licence Ouverte 2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence/). The interface shows the effective source-update time. Map data is attributed in the interface by the configured basemap provider.

## License

The application source is available under the [MIT License](LICENSE). Source data remains subject to the Licence Ouverte and each basemap provider’s terms.

# Architecture

Vélib’ Pulse runs as one Cloudflare Worker deployment with a React interface, scheduled collection, a JSON API, D1 storage, and a Durable Object live feed.

## Data paths

Collection and serving are separate paths:

```text
Collection

Vélib’ GBFS station metadata + status
                  │
                  ▼
          cron every minute
                  │
                  ▼
        decode and normalize
                  │
       ┌──────────┼──────────────┐
       ▼          ▼              ▼
 latest state  minute snapshot  5-minute rollups
       │          │              │
       └──────────┴──── D1 ──────┘
                  │
                  ▼
          compact network diff
                  │
                  ▼
         LiveFeed Durable Object
```

```text
Serving

Browser ──▶ Turnstile verification ──▶ signed HttpOnly session
   │
   ├──▶ Worker JSON API ──▶ D1 latest state, history, and replay
   │
   └──▶ LiveFeed Durable Object WebSocket ──▶ compact live diffs
```

The interface fetches an authoritative baseline from the API and applies compact WebSocket updates. It periodically reconciles with D1-backed state, so a dropped live update does not become permanent client state.

## Runtime components

### Scheduled collection

The Worker’s cron trigger runs every minute. Collection decodes the upstream Vélib’ Métropole GBFS feeds, updates station metadata and latest status, writes one compressed minute snapshot, derives completed five-minute rollups, and broadcasts a compact diff.

Collection begins after deployment; there is no required historical backfill. Stale and failed collections are recorded in `collection_runs` for health reporting.

### D1

D1 is authoritative. The schema stores:

- station metadata in `stations`;
- the current network snapshot in `latest_status`;
- compressed source observations in `minute_snapshots`;
- per-station five-minute aggregates in `station_rollups_5m`;
- network five-minute aggregates in `network_rollups_5m`; and
- collector outcomes in `collection_runs`.

Minute snapshots and rollups retain seven days of local history. Exact-key cleanup handles the normal retention path; bounded recovery passes remove older rows left by interrupted collections.

The replay endpoint scans a bounded minute window and returns one compact baseline followed by sparse sequential changes. Station charts read five-minute rollups rather than a row-per-station-per-minute history table.

### LiveFeed Durable Object

One named `LiveFeed` instance represents the network broadcast channel. It uses hibernating WebSockets and stores only serializable connection metadata in socket attachments. The object limits total connections and connections per client address; D1, not the object, remains the source of truth.

### Worker API

The Worker handles these routes:

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Collector and data-freshness status |
| `GET /api/session` | Current access-session status |
| `POST /api/session` | Verify Turnstile and issue a signed session cookie |
| `GET /api/live` | Current network baseline or reconciliation |
| `GET /api/live/socket` | LiveFeed WebSocket upgrade |
| `GET /api/replay?minutes=15\|30\|60` | Recent network replay |
| `GET /api/stations/:code` | Current station details |
| `GET /api/stations/:code/history?range=1h\|3h\|1d\|7d` | Station history |

`/api/health` and session bootstrap are public. Data routes require a valid signed session. Turnstile verification and authenticated API traffic use separate Workers Rate Limiting bindings.

### Static interface

Workers Static Assets serves the Vite-built React application. `run_worker_first` routes `/api/*` through Worker code while unknown interface paths use SPA fallback behavior.

The client uses React, Mantine, and MapLibre. URL state captures the map camera, filters, selection, layer, replay window, and replay timestamp so views remain shareable.

## Caching and consistency

- Live and station responses use short public cache lifetimes.
- Replay responses for fixed timestamps use a longer cache lifetime than moving-window responses.
- D1 remains authoritative across Worker isolates and Durable Object restarts.
- WebSockets carry incremental updates, not durable state.
- API reconciliation repairs missed or delayed live messages.

## Observability

Workers Logs and Traces are enabled with full head sampling. Cloudflare automatically records Worker and binding boundaries; application instrumentation should describe meaningful collection or request operations rather than duplicate every D1 call.

Operational procedures live in [Operations](operations.md).

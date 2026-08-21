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

The Worker’s cron trigger runs every minute. Collection decodes the upstream Vélib’ Métropole GBFS feeds, updates station metadata and latest status, writes one compressed minute snapshot, and broadcasts a compact diff. The default D1 history backend also derives completed five-minute rollups.

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

The snapshot endpoint reads one compressed retained state for fast logarithmic timeline navigation and before/after comparison. The replay endpoint scans a bounded minute window and returns one compact baseline followed by sparse sequential changes only when one-hour playback starts. Station charts read five-minute rollups rather than a row-per-station-per-minute D1 history table.

### Analytics archive and one-year history

The authoritative D1 snapshot transaction also queues immutable station-minute observations for a Pipeline-backed R2 Data Catalog Iceberg table. Scheduled work leases a bounded batch, retries Pipeline acceptance, and removes each claim only after success. Pipeline failure does not fail D1 collection. Raw Iceberg observations remain an offline repair and analysis source because direct R2 SQL latency is not suitable for interactive charts.

A second bounded D1 queue compacts completed station days from the existing five-minute rollups. It stores one-hour aggregates in one gzip R2 object per station and UTC month. D1 serves `1h`, `3h`, `1d`, and `7d`; direct R2 object reads serve `30d` and `1y`, with the retained D1 window overlaid as the authoritative current tail. One-year responses aggregate hourly objects to six-hour points.

See [Analytics archive](analytics.md) for object format, durability, resource ownership, retention, and rollback.

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
| `GET /api/snapshot?at=<unix-seconds>` | Compact retained network state at or before an archive point |
| `GET /api/replay?minutes=15\|30\|60&at=<unix-seconds>` | Bounded network replay ending at the latest or a retained archive point |
| `GET /api/stations/:code` | Current station details |
| `GET /api/stations/:code/history?range=1h\|3h\|1d\|7d` | Station history |

`/api/health` and session bootstrap are public. Data routes require a valid signed session. Turnstile verification and authenticated API traffic use separate Workers Rate Limiting bindings.

### Static interface

Workers Static Assets serves the Vite-built React application. `run_worker_first` routes `/api/*` through Worker code while unknown interface paths use SPA fallback behavior.

The client uses React, Mantine, TanStack Query, and MapLibre. Mantine theme palettes and semantic CSS tokens share one color, surface, control, typography, and responsive system across application and map chrome. A typed client-side locale provider owns French and English copy, locale-aware formatting, browser-language detection, and the persisted language preference. TanStack Query owns canonical live state, archive snapshots, replay windows, station-history caches, cancellation, and bounded retry policy. A separate subscription hook owns WebSocket connection and reconciliation state and writes validated updates into the Query cache. URL state captures the map camera, filters, selection, replay window, and replay timestamp so views remain shareable.

## Caching and consistency

- Live and station responses use short public cache lifetimes.
- Replay responses for fixed timestamps use a longer cache lifetime than moving-window responses.
- D1 remains authoritative across Worker isolates and Durable Object restarts.
- WebSockets carry incremental updates, not durable state.
- API reconciliation repairs missed or delayed live messages.

## Observability

Workers Logs and Traces are enabled with full head sampling. Cloudflare automatically records Worker and binding boundaries; application instrumentation should describe meaningful collection or request operations rather than duplicate every D1 call.

Operational procedures live in [Operations](operations.md).

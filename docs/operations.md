# Operations

Production is the `velib` Worker on the `velib.stanislas.cloud` custom domain. `workers.dev` and preview URLs are disabled. Commands in this document use the Wrangler version pinned by `bun.lock`.

Remote commands mutate production. Confirm the active Cloudflare account and target before applying migrations, changing secrets, deploying, rolling back, or restoring D1.

## Production prerequisites

Wrangler configuration declares the production D1 database, Durable Object migration, rate limiters, cron trigger, custom domain, Turnstile site key, static assets, and observability settings.

Two values must be stored as Worker secrets:

```bash
bunx wrangler secret put TURNSTILE_SECRET_KEY --config wrangler.jsonc
bunx wrangler secret put SESSION_SIGNING_SECRET --config wrangler.jsonc
```

Use a cryptographically random session-signing secret. Do not copy values from `.dev.vars` or `.dev.vars.example` into production.

Confirm authentication and generated bindings before a release:

```bash
bunx wrangler whoami
bun run cf-typegen:check
```

## Deploy

1. Start from a clean worktree and install the locked dependencies.
2. Run the same validation used by CI.
3. Apply pending D1 migrations before code that depends on them.
4. Deploy the Worker.
5. Complete the smoke tests below.

```bash
bun install --frozen-lockfile
bun run cf-typegen:check
bun run check
bun run db:migrate:remote
bun run deploy
```

`bun run deploy` repeats the project checks before invoking Wrangler. The D1 migration command is separate because schema changes must be reviewed and sequenced explicitly.

### Smoke tests

After deployment:

1. Check <https://velib.stanislas.cloud/api/health> for a successful, recent collection.
2. Open the interface and complete the Turnstile session flow.
3. Verify the live map, one station detail, each history range, and one replay window.
4. Confirm the WebSocket connects and a subsequent collection updates the interface.
5. Query persisted Workers Logs and Traces for the deployed version.

The collector runs every minute, so allow one collection interval before treating absent fresh data as a failure.

## Schema changes

Use expand/backfill/contract migrations:

1. add structures while old code remains compatible;
2. deploy code that can read both old and new representations;
3. backfill with a bounded, observable process when required; and
4. remove obsolete structures only after rollback compatibility is no longer needed.

A Worker rollback does not undo D1 migrations or Durable Object class migrations. Keep the previous Worker version compatible with the migrated schema until its rollback window closes.

Test the complete migration sequence against a fresh local D1 database before production:

```bash
rm -rf /tmp/velib-migration-check
bunx wrangler d1 migrations apply velib \
  --config wrangler.jsonc \
  --local \
  --persist-to /tmp/velib-migration-check
```

The `rm` command above only removes the disposable local validation directory shown in the example.

## Worker rollback

Use rollback for an application regression when the prior version remains compatible with the current D1 and Durable Object schema.

```bash
bunx wrangler deployments list --config wrangler.jsonc
bunx wrangler rollback <version-id> \
  --config wrangler.jsonc \
  --message "Rollback: <reason>"
```

Then repeat the deployment smoke tests. Record the failed and restored version IDs, current migration state, reason, and test results.

Do not use Worker rollback as a database rollback.

## D1 recovery

For suspected corruption, first prevent additional writes and determine the last known-good timestamp. Inspect the available D1 Time Travel point before restoring:

```bash
bunx wrangler d1 time-travel info velib \
  --config wrangler.jsonc \
  --timestamp <rfc3339-or-unix-timestamp>
```

A restore rewinds the production database and is destructive to newer data. Rehearse the recovery against a disposable database when possible, confirm the recovery point and expected data loss, and obtain explicit approval before running:

```bash
bunx wrangler d1 time-travel restore velib \
  --config wrangler.jsonc \
  --bookmark <bookmark>
```

After restoration, deploy a schema-compatible Worker if necessary and repeat the smoke tests. See Cloudflare’s current [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) for retention and restore behavior.

## Common local issues

### The map has no data

A fresh local D1 database is intentionally empty. Apply migrations, start the development server, and trigger the scheduled handler:

```bash
bun run db:migrate:local
bun run dev
curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

Check the development-server logs for upstream decoding or D1 errors.

### Generated bindings are stale

Regenerate and review them after changing `wrangler.jsonc`:

```bash
bun run cf-typegen
bun run cf-typegen:check
```

### Workerd tests fail after a migration

The Workerd suite applies all migrations to isolated D1 storage. Ensure every migration works from an empty database and that `src/worker/test/apply-migrations.ts` still discovers them in order.

## Telemetry

Workers Logs and Traces use full (`1.0`) head sampling. Before adding high-volume logging or custom spans, remove redundant per-query or per-item telemetry and check current Cloudflare usage and retention. Automatic Cloudflare spans already cover D1 and Durable Object binding calls.

See [Architecture](architecture.md) for runtime and storage design.

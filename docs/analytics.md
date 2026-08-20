# Analytics archive

The optional analytics path moves long-range station history computation out of the Worker. D1 remains authoritative for live state, replay, and exact one-hour history.

```text
minute collection
   ├── D1 snapshot ──▶ live, replay, one-hour history
   └── Pipeline stream ──▶ R2 Data Catalog ──▶ R2 SQL long-range history
```

## CPU objective

The production baseline measured before this change was:

| Invocation | Samples | Average CPU | P50 | P95 | P99 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cron | 360 | 140 ms | 112 ms | 286 ms | 333 ms |
| Durable Object RPC | 350 | 11 ms | 11 ms | 19 ms | 24 ms |

The R2 backend disables D1 five-minute rollup creation. It is successful only if Cron CPU per hour and P95 both decrease by at least 20% over a comparable 24-hour period. API correctness, freshness, latency, and error rate must not regress materially.

## Resources

Durable account resources belong in `cloudflare-tf`:

- R2 bucket: `velib-analytics`
- R2 Data Catalog namespace: `velib`
- Iceberg table: `station_observations_v1`
- Pipeline stream: `velib_station_observations_stream_v1`
- Pipeline sink: `velib_station_observations_catalog_v1`
- Pipeline: `velib_station_observations_v1`

The stream uses `pipelines/station-observations.schema.json`. The pipeline uses `pipelines/station-observations.sql`. Disable the stream HTTP endpoint. Add the resulting stream ID to `wrangler.jsonc`:

```json
{
  "pipelines": [
    {
      "binding": "OBSERVATIONS",
      "stream": "<stream-id>"
    }
  ]
}
```

The catalog sink needs a dedicated R2 Admin Read & Write account token. Do not pass it through OpenTofu. Store it in the approved secret manager, register it through the Data Catalog credential API, and create the sink through the Pipeline API. Then declare and import the sink in `cloudflare-tf` with `config.token` omitted. Verify that the imported state has no bearer token and that a targeted plan is clean. Sink configuration is immutable, so credential replacement needs a reviewed sink and pipeline recreation.

The Worker needs a separate `R2_SQL_TOKEN` secret with read access to R2 SQL, R2 Data Catalog, and the `velib-analytics` bucket. Upload it only before the R2 history stage. Never store either token in this repository or OpenTofu state.

## Safe rollout

1. Add and review the account resources in `cloudflare-tf`.
2. Review the complete OpenTofu plan before any apply.
3. Add the resulting stream ID as the `OBSERVATIONS` Pipeline binding in `wrangler.jsonc`.
4. Keep `HISTORY_BACKEND` set to `d1`. This shadows station observations while D1 continues to serve history and build rollups.
5. Verify Pipeline error metrics, Iceberg row counts, duplicate event IDs, and missing station-minutes. The Worker retries stream acceptance three times, but it has no durable cross-product transaction with D1. Alert and reconcile any remaining gap before disabling D1 rollups.
6. Wait until the archive contains the complete history range required by the interface.
7. Upload the `R2_SQL_TOKEN` Worker secret.
8. Change `HISTORY_BACKEND` to `r2` and deploy.
9. Compare at least 24 hours by `cloudflare.script_version.id` against the CPU objective.

The Worker disables D1 rollups only when all R2 settings, the Pipeline binding, and the R2 SQL token are present. Missing configuration keeps the D1 path active.

## Rollback

D1 minute snapshots continue throughout the experiment, but D1 long-range rollups stop while the R2 backend is active. The automatic repair pass covers only the latest hour. Before switching `HISTORY_BACKEND` back to `d1`, rebuild older missing rollups from retained snapshots with a reviewed bounded backfill, or accept gaps in long-range charts. Keep the R2 backend and archive available until that recovery is complete. Do not delete the archive during rollback.

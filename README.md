# Minimal Observation

A **feather-light distributed-tracing APM** — think a tiny Elastic APM + Kibana you can run from one
`docker compose up`. It ingests OpenTelemetry, stores traces in embedded **DuckDB** with a tiered
hot → warm → cold(S3) design, serves a **React** UI, and ships an **AI investigator** that pivots across
your data to find root causes.

The design bet: **don't reinvent instrumentation.** Client apps use the OpenTelemetry SDK (all the
framework middlewares, SQL/fs/messaging instrumentation, and W3C distributed-trace propagation you'd
ever want). Minimal Observation is the small part worth building — the backend, storage, UI, and agent.

## Features

- **Distributed tracing** via OpenTelemetry (TypeScript). `@mo/tracing` is a one-call setup with
  **HTTP header enrichment**, framework middleware (Express, Fastify, Koa, Nest, Hapi…), and a **SQL
  row-count** hook (`db.statement` + rows returned / rows iterated for streamed results).
- **Dependencies as spans**: SQL/DB, external HTTP, messaging, and **filesystem** access, plus
  **custom spans and transactions** (`withSpan`, `startTransaction`, `recordDbRows`).
- **UI** (minimal Kibana): services list → service (endpoints) → endpoint (percentiles, error rate,
  performance breakdown, charts) → single request **waterfall**; dependencies with their top calling
  services/endpoints; a **custom SQL + chart** view.
- **Percentiles everywhere**, from mergeable per-hour latency histograms (overview) or exact from raw
  (endpoint drill-in).
- **AI investigator**: "Investigate performance issue" — an agent that jumps from a slow trace to similar
  ones, to the same dependency across services, or compares fast-vs-slow cohorts. Each jump is one query.
- **Export** any span set as JSON/CSV for ChatGPT/Claude, from the UI or `/api/export`.
- **API-key** auth on ingest and query. **7-day retention** (configurable). No durability — by design.

## Quick start

```bash
# 1) Full stack with a MinIO-mocked S3 cold tier
docker compose up          # → UI at http://localhost:4318  (key: dev-secret-key)

# 2) Or run locally without Docker (in-process, local Parquet cold tier)
pnpm install
pnpm --filter @mo/shared build && pnpm --filter @mo/tracing build
pnpm build
pnpm start &               # server on :4318
pnpm seed                  # load demo traces
#   open http://localhost:4318 and enter dev-secret-key

# 3) See real OpenTelemetry data from an instrumented app
pnpm sample                # Express gateway→backend, exports to :4318
```

Enable the AI investigator by setting `ANTHROPIC_API_KEY` (see `.env.example`).

## How storage works (the feather-light part)

| Tier | What | Where |
|------|------|-------|
| Hot | micro-batch buffer | RAM (flush every ~2s) |
| Warm | today's spans + hourly rollups | `warm.duckdb` / `rollups.duckdb` (local disk) |
| Cold | frozen day-partitioned Parquet | local dir **or** S3/MinIO (`httpfs`) |

At local midnight, the day freezes to Parquet and its raw spans drop from warm; small **histogram
rollups** stay resident so week-long overviews never touch cold storage. Drilling into an old trace
**unpacks** that day's Parquet on demand and evicts it after an idle timeout. Retention is an S3 lifecycle
rule (cold) plus a rollup `DELETE`. Anything unflushed on a crash is lost — an explicit, accepted trade.

See [`CLAUDE.md`](./CLAUDE.md) for architecture details, layout, and gotchas.

## Two server implementations

Same OTLP ingest, same query API, same React UI — pick your storage engine by footprint:

| | `packages/server` (TS + DuckDB) | [`sqlite-server`](./sqlite-server) (Go + SQLite) |
|---|---|---|
| RSS idle / loaded (17.4k spans) | 115 / 232 MB | **9 / 54 MB** |
| Distribution | node + node_modules | one 15 MB pure-Go binary |
| Ad-hoc SQL | full DuckDB (columnar, `quantile_cont`, Parquet) | standard SQL only |
| Cold tier | Parquet, local or S3/MinIO | none needed — flat RAM, `DELETE` retention |
| AI investigator | ✅ | ✅ |

The **TypeScript/DuckDB** server is the reference (S3 cold tier, columnar analytics, arbitrary
DuckDB SQL). The **Go/SQLite** server is the lightweight option at feature parity for the core
product — including the AI investigator — its page cache keeps RSS flat regardless of retained
volume, so it drops the tiering entirely. Both pass the same UI + agent e2e in CI. Details + the
full comparison: [`sqlite-server/README.md`](./sqlite-server/README.md).

## Configuration

Copy `.env.example` → `.env`. Key knobs: `MO_API_KEY`, `MO_PORT`, `MO_DATA_DIR`, `MO_RETENTION_DAYS`,
`MO_COLD_KIND` (`local`|`s3`) + `MO_S3_*`, `MO_FLUSH_MAX_ROWS/MS`, `MO_COLD_IDLE_MS`, `ANTHROPIC_API_KEY`.

## License

MIT

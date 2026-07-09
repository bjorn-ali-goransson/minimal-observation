# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

**Minimal Observation** — a feather-light distributed-tracing APM (a tiny Elastic-APM/Kibana).
The hard, sprawling part (instrumentation) is delegated to **OpenTelemetry**; what we build is the
**backend + storage + UI + AI investigator**. Everything is TypeScript except the storage engine
(DuckDB, embedded).

Data model (derived from OTel spans, never re-derived downstream):
- **service** = OTel `service.name`
- **transaction** = a root/entry span (`kind = SERVER|CONSUMER`) — `is_transaction`
- **span / dependency** = a child span (`kind = CLIENT|PRODUCER` → a dependency; `INTERNAL` → custom timespan)

## Architecture (one server process)

```
OTel SDK (client)  ──OTLP/HTTP JSON + x-api-key──▶  POST /v1/traces
                                                     │ micro-batch buffer (RAM)
                                                     ▼ flush every MO_FLUSH_MAX_MS / _ROWS
   HOT: today.  →  WARM: warm.duckdb (spans table)  ──00:00 local──▶  COLD: day=YYYY-MM-DD/*.parquet
                     rollups.duckdb (hourly histograms, all days)      (local dir OR s3/MinIO via httpfs)
   Query API + React UI + AI agent all read via one DuckStore.
```

Tiering rationale (see the design in git history / README):
- **Rollups** (per-hour, per-(service,name,span_type,dependency) latency **histograms**) make multi-day
  overview screens cheap and keep them working after raw data goes cold. Histograms are *mergeable*, so
  "p95 over 7 days" needs no raw spans. Exact percentiles for a single endpoint come from raw hot data.
- **Cold** is day-partitioned Parquet. Overviews read rollups; drilling into an old trace **unpacks** that
  day's Parquet into a temp table with a **sliding idle eviction** (`MO_COLD_IDLE_MS`).
- **Retention**: S3 lifecycle rule (cold) + a `DELETE` on rollups. Local cold is dir-deleted by the sweeper.

## Layout

- `packages/shared` — `@mo/shared`: `Span` type, OTLP→Span decoder, latency-histogram math. No deps.
- `packages/server` — `@mo/server`: Fastify (ingest + query + agent + static UI). `store/DuckStore.ts` is
  the tiered store; `aggregate.ts` turns rollup rows into view payloads; `agent.ts` is the tool-use loop.
- `packages/tracing` — `@mo/tracing`: one-call OTel setup (auto-instrumentation, header enrichment, SQL
  row-count hook), plus `withSpan` / `startTransaction` / `recordDbRows`.
- `packages/ui` — `@mo/ui`: React + Vite + uPlot. Tiny hash router. Views: Services, Service, Endpoint,
  Trace (waterfall), Dependencies, Dependency, Query (custom SQL + chart), Agent.
- `services/sample` — `@mo/sample`: a real instrumented Express app (gateway→backend) that emits traces.
- `e2e` — Playwright, **hermetic**: no external services. The config boots the app (local cold tier)
  and a **mock Anthropic** server (`mocks/anthropic.mjs`); the agent's `baseURL` is pointed at it so the
  real tool loop runs offline. `smoke.spec.ts` (UI), `agent.spec.ts` (mocked LLM), `cold.spec.ts`
  (freeze; gated by `MO_TEST_COLD=1`). Set `MO_BASE_URL` to test an external stack (compose + MinIO-as-S3).

## Commands

```bash
pnpm install
pnpm --filter @mo/shared build && pnpm --filter @mo/tracing build   # build libs first (server/ui import dist)
pnpm dev:server        # tsx watch — ingest+query+UI on :4318 (needs @mo/shared built)
pnpm dev:ui            # Vite on :5173, proxies /api and /v1 to :4318
pnpm build             # build all packages (shared, tracing, server, ui)
pnpm start             # run compiled server (node packages/server/dist/index.js)
pnpm seed              # POST ~400 synthetic OTLP traces to the running server
pnpm sample            # run the instrumented Express sample (real OTel spans)
pnpm typecheck         # tsc across the workspace
pnpm e2e               # build, then hermetic Playwright run (boots app + mock Anthropic, no network)
                       # against an external stack instead:  MO_BASE_URL=… pnpm --filter @mo/e2e test
docker compose up      # full stack incl. MinIO-as-S3 cold tier
```

Auth: every `/api/*` and `/v1/*` call needs the API key via `x-api-key`, `Authorization: ApiKey|Bearer`,
or (browser downloads only) `?k=`. Default dev key `dev-secret-key`.

## Conventions / gotchas

- **DuckDB**: single writer — keep ingest + query in one process. Appender needs `appendNull()` for nulls.
  Counts return as `bigint` (down-converted in `duck.ts#all`). **Never `SELECT` a raw epoch-ns BIGINT**
  (exceeds `Number.MAX_SAFE_INTEGER`) — select `col/1e6` as ms. `rows` is a reserved alias — don't use it.
- **OTLP JSON only** at `/v1/traces` (configure the OTel exporter as `exporter-trace-otlp-http`, not proto).
- **Loss is acceptable** by design: up to one flush interval, plus today-so-far on a crash (today only
  reaches cold at midnight). Do not add durability/WAL/sync — it's an explicit non-goal.
- The `store/*.sql` strings are inlined and value-escaped via `q()`. Custom SQL (`/api/query`) is
  `SELECT`/`WITH`-only, keyword-blocklisted, and wrapped so `spans` = the retention-window relation.
- Build order matters: `@mo/shared` (and `@mo/tracing`) must be built before `@mo/server`/`@mo/ui` typecheck,
  because they import from `dist`.

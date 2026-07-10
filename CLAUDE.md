# CLAUDE.md

Guidance for Claude Code (and humans) working in this repo.

## What this is

**Minimal Observation** — a feather-light distributed-tracing APM (a tiny Elastic-APM/Kibana).
Instrumentation is delegated to **OpenTelemetry**; we build the **server + storage + UI + AI
investigator**. The server is a single **pure-Go** binary using **embedded SQLite** for raw spans
and **in-process histogram rollups** for overviews. (A TypeScript/DuckDB server existed earlier and
was removed in favour of this lighter one; a Go+DuckDB benchmark lives on branch
`claude/go-server-rewrite`.)

Data model (derived from OTel spans, never re-derived downstream):
- **service** = OTel `service.name`
- **transaction** = a root/entry span (`kind = SERVER|CONSUMER`) — `is_transaction`
- **span / dependency** = a child span (`kind = CLIENT|PRODUCER` → a dependency; `INTERNAL` → custom timespan)

## Architecture (one Go process)

```
OTel SDK (client)  ──OTLP/HTTP JSON + x-api-key──▶  POST /v1/traces
                                                     │ micro-batch buffer (RAM)
                                                     ▼ flush every MO_FLUSH_MAX_MS / _ROWS
   HOT: spans.sqlite (recent, unfrozen)   ── day rollover / admin ──▶  FROZEN: day=YYYY-MM-DD/
   ROLLUPS: in-memory histograms (all days, tiny)                        spans.sqlite + rollups.json
   Query API + React UI + AI agent all read via one Store.               (local dir OR s3/MinIO)
```

Why this shape:
- **In-memory rollups** (per-hour histograms per (service,name,span_type,dependency)) serve every
  overview/chart/percentile screen with no query engine. They're mergeable, so multi-day percentiles
  are cheap and survive frozen days. Endpoint-detail percentiles are computed **exactly** in Go.
- **Flat RAM**: SQLite reads through a small page cache (`cache_size≈2MB`), so RSS stays ~flat as data
  grows. Idle ≈ 9 MB, loaded ≈ 50–80 MB regardless of row count.
- **Frozen tier** ships a finished day's hot spans to a per-day SQLite file (+ a small `rollups.json`
  snapshot) on the frozen store — local dir or **S3/MinIO** (`minio-go`) — then deletes them from hot.
  Reads `UNION` hot with any frozen days in range, attaching each day's file (downloaded from S3 on
  first touch) and evicting it after `MO_COLD_IDLE_MS` idle. On restart, overviews reload from the
  rollup snapshots; drill-in lazily re-downloads the raw file. The UI shows a **cold-load badge**
  (`/api/frozen` + the `X-MO-Cold` response header).
- **Retention**: hot `DELETE` sweep + `incremental_vacuum`; frozen days past retention are dropped.
- **Loss is acceptable** by design (`synchronous=OFF`): up to one flush interval on a crash. Do not
  add durability/WAL sync.

## Layout

- `sqlite-server/` — **the server** (Go, package `main`): `store.go` (SQLite + rollups + frozen tier),
  `frozen.go` (local/S3 frozen store), `otlp.go` (OTLP→Span decode + derivation), `histogram.go`,
  `aggregate.go`, `agent.go` (Anthropic tool-use loop over raw net/http), `server.go` (HTTP + auth +
  static UI), `config.go`, `main.go`.
- `packages/ui` — `@mo/ui`: React + Vite + uPlot. Views: Services, Service, Endpoint, Trace
  (waterfall), Dependencies, Dependency, Query (custom SQL + chart), Agent. Cold badge in the top bar.
- `packages/tracing` — `@mo/tracing`: one-call OTel setup (auto-instrumentation, header enrichment,
  SQL row-count hook), plus `withSpan` / `startTransaction` / `recordDbRows`.
- `services/sample` — `@mo/sample`: a real instrumented Express app (gateway→backend).
- `scripts/seed.mjs` — standalone OTLP load generator (`pnpm seed`).
- `e2e` — Playwright, hermetic: boots the Go server (local frozen tier) + a mock Anthropic server;
  `smoke.spec` (UI), `agent.spec` (mocked LLM), `cold.spec` (freeze + read-back).

## Commands

```bash
pnpm install
pnpm build              # build UI + tracing + the Go server (sqlite-server/moserver_sqlite)
pnpm start              # run the built server on :4318 (serves the built UI)
pnpm dev:server         # go run the server (needs Go toolchain)
pnpm dev:ui             # Vite on :5173, proxies /api and /v1 to :4318
pnpm seed               # POST ~400 synthetic OTLP traces to the running server
pnpm sample             # run the instrumented Express sample (real OTel spans)
pnpm typecheck          # tsc across UI + tracing
pnpm e2e                # build, then hermetic Playwright run (Go server + mock Anthropic, no network)
docker compose up       # full stack incl. MinIO-backed S3 frozen tier
```

Auth: every `/api/*` and `/v1/*` call needs the API key via `x-api-key`, `Authorization: ApiKey|Bearer`,
or (browser downloads only) `?k=`. Default dev key `dev-secret-key`.

## Conventions / gotchas

- **Go 1.24, CGO not required** — `modernc.org/sqlite` is pure Go; build with `CGO_ENABLED=0`.
- **SQLite single writer**: `MaxOpenConns(1)`; ingest micro-batches insert in one tx. Never `SELECT`
  raw epoch-ns as a JS number downstream — the API selects `col/1e6` as ms.
- **Rollups live in RAM** and are rebuilt from hot spans + frozen `rollups.json` snapshots on startup.
- **Custom SQL** (`/api/query`) is `SELECT`/`WITH`-only, keyword-blocklisted (word-boundary), wrapped so
  `spans` = the full retention window (hot ∪ frozen). Standard SQL only — no DuckDB-specific functions.
- **OTLP JSON only** at `/v1/traces` (configure the OTel exporter as `exporter-trace-otlp-http`).
- The UI is shared; keep query samples portable. `@mo/tracing` and the sample are TS and independent of
  the server.

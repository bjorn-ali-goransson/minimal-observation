# Backlog

## 1. Finish the Go server port → drop-in replacement
Branch `claude/go-server-rewrite` ports `@mo/server` to Go and is a faithful benchmark
(passes the smoke suite; ~2.2× lighter than Node — see `go-server/README.md`). To make it a
real replacement, still to do:
- **S3 cold tier** — the Go port only does the *local* Parquet cold tier. `go-duckdb` supports
  the `httpfs` extension, so port `ColdStore` s3 mode (secret + `read_parquet('s3://…')`).
- **AI agent** — `/api/agent` returns 503 in Go. Port the tool-use loop (raw HTTP to the
  Anthropic Messages API; no SDK needed) with the same tools.
- **e2e** — once both land, run the full hermetic suite (incl. `cold.spec` via MinIO and
  `agent.spec` via the mock) against the Go server, and add it to CI as a second matrix leg.

## 2. Evaluate a lighter-than-DuckDB store (spike)
We concede DuckDB gives us ~33 MB of engine floor. Explore lighter backends, trading a few
features. Key insight: **only two features truly need a general SQL engine** — the custom SQL
view (`/api/query`) and the agent's `run_sql` tool. Everything else is (a) rollups
(mergeable histograms, already engine-free math in `@mo/shared`), (b) trace-id key lookups,
(c) filtered scans of raw spans in a window.

Candidates (see the discussion for trade-offs):
- **SQLite (modernc pure-Go)** — smallest concession: keeps SQL + `run_sql`, no CGO, ~few-MB
  engine. Concede: columnar analytics speed at scale, native `quantile_cont` (use our
  histograms / manual), Parquet cold tier (per-day SQLite files or gzipped NDJSON).
- **Purpose-built Go store** (rollups in-process + `bbolt`/indexed raw spans) — lightest
  (~near the Go-runtime floor). Concede: custom SQL view and agent `run_sql` (replace with the
  structured query tools the agent already has), and we write the aggregation code.
- **Hybrid** — plain-Go rollups as the workhorse (no engine at all) + a thin raw store for
  drill-down/retention (SQLite if we keep SQL, `bbolt` if we go lightest).

Spike goal: idle RSS well under DuckDB's ~33 MB while keeping the services/endpoint/trace/
dependency views and passing the smoke suite. Decision gate: **do we keep ad-hoc SQL?** — that
single choice picks SQLite vs. purpose-built.

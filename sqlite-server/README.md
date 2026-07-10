# moserver-sqlite — lighter-storage spike (Backlog #2, Option A)

A variant of the Go server that swaps DuckDB for **pure-Go SQLite** (`modernc.org/sqlite`, no
CGO) for raw spans, and keeps the overview/chart/percentile screens on **in-process rollups**
(mergeable histograms — no engine at all). Same env contract, same React UI, same query API.

The bet: only the *custom SQL view* and the agent's `run_sql` truly need a general SQL engine;
everything else is rollups + trace-id lookups + windowed scans. So SQLite only carries the
ad-hoc-SQL + retention weight, and it's tiny.

## Result — storage backend memory (same box, same UI, ~17.4k spans)

| | Node+DuckDB | Go+DuckDB | **Go+SQLite** |
|---|---|---|---|
| RSS idle (0 spans) | 115 MB | 33 MB | **9 MB** |
| RSS loaded (17.4k spans) | 232 MB | 112 MB | **54 MB** |
| RSS peak | 232 MB | 112 MB | 65 MB |
| distribution | node + node_modules | 57 MB binary (CGO) | **15 MB binary, pure-Go** |

Go+SQLite is **~8% of Node's idle** and ~23% loaded. The ~9 MB idle is essentially just the Go
runtime + a small SQLite page cache (`cache_size=-2000` ≈ 2 MB) + the rollup maps.

## Parity

Passes **4 of 5** of the shared Playwright smoke tests against the same UI (services →
endpoint → trace waterfall, dependencies + callers, auth). Endpoint-detail percentiles are
**exact** (computed in Go), and match the DuckDB numbers. The one failing test is the
concession below — not a bug.

## Concessions (vs DuckDB)

- **No DuckDB-only SQL functions** in the custom query view — `quantile_cont`, `list`,
  `read_parquet`, `//`, etc. Standard SQL works fine (`count`, `avg`, `sum`, `group by`, CTEs,
  `json_extract`). The UI's default "Slowest DB statements" sample uses `quantile_cont`, so it
  errors on SQLite; rewrite it with `avg`/`count` and it works. *(This is the failing smoke test.)*
- **No columnar analytics speed** — SQLite is a row store. Indexed filters (service/name/time,
  trace_id, dependency) are fast; a full-table `GROUP BY` over millions of rows is slower than
  DuckDB. Fine at APM-for-a-few-days scale; the hot overview path never touches raw (it reads
  rollups).
- **Overview percentiles are histogram-approximate** (same as the DuckDB overview path).
- **No cold tier in this spike** — a single retention-swept SQLite file (`synchronous=OFF`,
  loss acceptable). Production Option A would freeze to per-day SQLite files or gzipped NDJSON
  on S3.
- **Agent** (`/api/agent`) returns 503, same as the DuckDB Go port.

## Design notes

- **Rollups live in Go memory** (`map[rollupKey]*rollupAgg`, one latency histogram per
  `(hour, service, name, span_type, dependency, is_transaction)`), updated on ingest and
  rebuilt from the spans table on startup. Overviews/charts read them directly — no query engine.
- **Raw spans** in SQLite with partial/secondary indexes; `MaxOpenConns=1` (single writer) keeps
  it simple and the memory floor tiny.

## Build & run

```bash
cd sqlite-server
CGO_ENABLED=0 go build -o moserver_sqlite .
MO_API_KEY=dev-secret-key MO_DATA_DIR=./data MO_UI_DIR=../packages/ui/dist ./moserver_sqlite
# smoke: MO_BASE_URL=http://localhost:4318 pnpm --filter @mo/e2e test smoke.spec.ts
```

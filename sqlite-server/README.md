# moserver-sqlite — the lightweight Go server (SQLite)

A production variant of the server that swaps DuckDB for **pure-Go SQLite**
(`modernc.org/sqlite`, no CGO) for raw spans, and keeps the overview/chart/percentile screens
on **in-process rollups** (mergeable histograms — no engine at all). Same env contract, same
React UI, same query API. Ingest, query, and static UI in one small static binary.

The bet: only the custom SQL view and the agent's `run_sql` truly need a general SQL engine;
everything else is rollups + trace-id lookups + windowed scans. So SQLite only carries the
ad-hoc-SQL + retention weight — and it's tiny.

## Memory — storage backend comparison (same box, same UI, ~17.4k spans)

| | Node+DuckDB | Go+DuckDB | **Go+SQLite** |
|---|---|---|---|
| RSS idle (0 spans) | 115 MB | 33 MB | **9 MB** |
| RSS loaded (17.4k spans) | 232 MB | 112 MB | **54 MB** |
| distribution | node + node_modules | 57 MB binary (CGO) | **15 MB binary, pure-Go** |

**RAM is flat as data grows.** SQLite's page cache is capped (`cache_size≈2 MB`), so RSS does
*not* track row count — measured over a 7-day window:

```
idle 9 MB → 29k:76MB → 58k:74MB → 87k:79MB → 116k:79MB → 145k spans:74MB   (disk grew 13M→26M)
```

That's the headline design consequence: **the SQLite variant needs no hot/warm/cold tiering for
memory.** Retention is a `DELETE` sweep + `PRAGMA incremental_vacuum` to return pages to the OS.
S3/Parquet archival becomes optional, not structural.

## Parity

Passes **all 5** shared Playwright smoke tests against the same UI (services → endpoint →
trace waterfall, dependencies + callers, custom SQL, auth). Endpoint-detail percentiles are
**exact** (computed in Go) and match the DuckDB numbers. CI runs this suite against the SQLite
server as its own job (`sqlite-e2e`).

## Concessions (vs DuckDB)

- **No DuckDB-only SQL functions** in the custom query view — `quantile_cont`, `list`,
  `read_parquet`, `//`. Standard SQL works (`count`/`avg`/`sum`/`group by`/CTEs/`json_extract`);
  the shipped UI samples are written portably.
- **No columnar analytics speed** — SQLite is a row store. Indexed filters (service/name/time,
  trace_id, dependency) are fast; a full-table `GROUP BY` over millions of rows is slower than
  DuckDB. The hot overview path never touches raw — it reads in-memory rollups.
- **Overview percentiles are histogram-approximate** (same as DuckDB's overview path).
- **Frozen tier (local or S3/MinIO)** — finished days freeze to a per-day SQLite file + a small
  `rollups.json` snapshot on the frozen store; hot rows are then deleted. Reads UNION hot with any
  frozen days in range (downloaded from S3 on first touch via `minio-go`, evicted after
  `MO_COLD_IDLE_MS` idle). Overviews reload from snapshots on restart; the UI shows a cold-load
  badge. Note this is about durability/offload, not memory — RSS is flat regardless (above).

The **AI investigator is supported** here: `/api/agent` runs the same Anthropic Messages API
tool-use loop as the TypeScript server, implemented in Go over raw `net/http` (no SDK), driving
the same query tools (`list_services`, `get_endpoint`, `list_traces`, `get_trace`, `run_sql`, …).
Enable it with `ANTHROPIC_API_KEY`. CI exercises it against the mock LLM (`agent.spec`).

## Design notes

- **Rollups in Go memory** (`map[rollupKey]*rollupAgg`, one latency histogram per
  `(hour, service, name, span_type, dependency, is_transaction)`), updated on ingest and rebuilt
  from the spans table on startup. Overviews/charts read them directly — no query engine.
- **Raw spans** in one SQLite file with partial/secondary indexes; `MaxOpenConns=1`,
  `synchronous=OFF` (loss acceptable), `auto_vacuum=INCREMENTAL`.

## Build & run

```bash
cd sqlite-server
CGO_ENABLED=0 go build -o moserver_sqlite .
MO_API_KEY=dev-secret-key MO_DATA_DIR=./data MO_UI_DIR=../packages/ui/dist ./moserver_sqlite
# smoke: MO_BASE_URL=http://localhost:4318 pnpm --filter @mo/e2e test smoke.spec.ts
```

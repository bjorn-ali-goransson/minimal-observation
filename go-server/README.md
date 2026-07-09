# moserver — Go port (memory experiment)

A faithful Go rewrite of `@mo/server` (OTLP ingest + query API + static UI over the tiered
DuckDB store), built to answer one question: **how much of the TypeScript server's memory is
the DuckDB engine vs. the Node/V8 runtime?**

It keeps everything comparable: same env contract, same DuckDB config (`memory_limit=512MB`,
`threads=2`), same table/rollup schema and SQL, and it serves the **same built React UI**
(`packages/ui/dist`). DuckDB is reached via [`go-duckdb`](https://github.com/marcboeker/go-duckdb)
(CGO; the DuckDB engine is statically linked).

## Result (same box, same ~17.4k-span load, both compiled)

| Metric | Node/TS (`dist`) | Go | Go vs Node |
|---|---|---|---|
| RSS idle (0 spans) | 115 MB | **33 MB** | 29% |
| RSS loaded (17.4k spans) | 251 MB | **112 MB** | 45% |
| RSS peak | 258 MB | 112 MB | 43% |

Takeaways:
- **~33 MB is the DuckDB floor** — that's Go idle, almost entirely the embedded engine. Both
  languages pay it.
- **Node adds ~82 MB of V8/runtime** on top before serving a single request.
- Under load DuckDB's working set grows in both; Go stays ~2.2× lighter throughout.
- Distribution differs too: Node needs `node` + `node_modules`; Go is a single static binary
  (~57 MB on disk, but that's disk, not RAM).

## Parity

The Go server passes the **same Playwright smoke suite** as the TypeScript one (services →
endpoint → trace waterfall, dependencies + callers, custom SQL, auth):

```bash
MO_DATA_DIR=/tmp/mo-go MO_PORT=4406 MO_UI_DIR=../packages/ui/dist ./moserver &
MO_BASE_URL=http://localhost:4406 pnpm --filter @mo/e2e test smoke.spec.ts   # 5 passed
```

## Scope

Ported: OTLP/HTTP JSON ingest + span derivation, micro-batch → warm DuckDB → **local** cold
Parquet tiering (freeze/unpack/retention), hourly histogram rollups, all read endpoints, custom
read-only SQL, export, admin freeze, static UI + API-key auth. **Not ported:** the S3 cold
backend and the AI agent (`/api/agent` returns 503) — neither affects the memory comparison.

The port surfaced two real bugs the Node DuckDB driver silently tolerated: `sum()` over BIGINT
returns HUGEINT (needs an explicit `::BIGINT`/`::DOUBLE` cast to scan in Go), and the SQL
keyword blocklist must use word boundaries (`\bcall\b`) so identifiers like `calls` aren't rejected.

## Build & run

```bash
cd go-server
CGO_ENABLED=1 go build -o moserver .
MO_API_KEY=dev-secret-key MO_DATA_DIR=./data MO_UI_DIR=../packages/ui/dist ./moserver
# then: (cd ../packages/server && MO_TARGET=http://localhost:4318 pnpm seed)
```

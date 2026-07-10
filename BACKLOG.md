# Backlog

## Decided / shipped
- **Lighter-than-DuckDB storage (Option A).** Evaluated and adopted: a pure-Go **SQLite** server
  (`sqlite-server/`) for raw spans + in-process histogram rollups for overviews. ~9 MB idle vs
  DuckDB's 33 MB / Node's 115 MB; RAM stays flat as data grows, so it needs no hot/warm/cold
  tiering (retention = `DELETE` + incremental vacuum). Passes the shared smoke suite in CI.
  See `sqlite-server/README.md`. The Go+DuckDB benchmark lives on branch
  `claude/go-server-rewrite` (kept for reference, not merged).

## Open
1. **AI agent for the Go/SQLite server.** `/api/agent` returns 503 there; the TypeScript/DuckDB
   server carries the investigator. Port the tool-use loop to Go (raw HTTP to the Anthropic
   Messages API — no SDK needed) with the same tools, then wire `agent.spec` against it.
2. **Optional S3 archival for the SQLite server.** Not needed for memory or retention (flat RAM
   + `DELETE` sweep already bound both), but useful for durability / long-term retention: on the
   retention boundary, ship expiring rows to S3 as gzipped NDJSON (or per-day SQLite files) and
   read them back on demand for deep history. Purely additive.
3. **Decide long-term server topology.** Two implementations now coexist on `main` (TS+DuckDB
   reference, Go+SQLite lightweight). Revisit once the agent lands on Go whether to keep both or
   make Go/SQLite the sole server.

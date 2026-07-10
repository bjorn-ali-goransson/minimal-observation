# Backlog

## Decided / shipped
- **Lighter-than-DuckDB storage (Option A).** Evaluated and adopted: a pure-Go **SQLite** server
  (`sqlite-server/`) for raw spans + in-process histogram rollups for overviews. ~9 MB idle vs
  DuckDB's 33 MB / Node's 115 MB; RAM stays flat as data grows, so it needs no hot/warm/cold
  tiering (retention = `DELETE` + incremental vacuum). Passes the shared smoke suite in CI.
  See `sqlite-server/README.md`. The Go+DuckDB benchmark lives on branch
  `claude/go-server-rewrite` (kept for reference, not merged).
- **AI investigator on the Go/SQLite server.** Ported the Anthropic Messages API tool-use loop
  to Go (raw `net/http`, no SDK) with the same tools; `/api/agent` is live and CI exercises it
  against the mock LLM (`agent.spec`). The Go/SQLite server is now at core feature parity.

## Open
1. **Optional S3 archival for the SQLite server.** Not needed for memory or retention (flat RAM
   + `DELETE` sweep already bound both), but useful for durability / long-term retention: on the
   retention boundary, ship expiring rows to S3 as gzipped NDJSON (or per-day SQLite files) and
   read them back on demand for deep history. Purely additive.
2. **Decide long-term server topology.** Two implementations now coexist on `main` (TS+DuckDB
   reference, Go+SQLite lightweight, both with the agent). Decide whether to keep both or make
   Go/SQLite the sole server (DuckDB retains arbitrary-SQL + columnar analytics + Parquet/S3).

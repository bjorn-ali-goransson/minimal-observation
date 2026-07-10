# Backlog

## Decided / shipped
- **Storage: pure-Go SQLite is the sole server.** The TypeScript/DuckDB server was removed; the Go
  server (`sqlite-server/`) with embedded SQLite + in-process histogram rollups is now the only one.
  ~9 MB idle; RAM flat as data grows. The Go+DuckDB benchmark stays on branch
  `claude/go-server-rewrite` for reference.
- **AI investigator** ported to Go (Anthropic tool-use loop over raw net/http). `/api/agent` live; CI
  exercises it against a mock LLM.
- **S3 (or local) frozen tier.** Finished days freeze to a per-day SQLite file + rollup snapshot on the
  frozen store (local dir or S3/MinIO via minio-go); hot rows are deleted. Reads UNION hot with frozen
  days (downloaded from S3 on first touch, idle-evicted). Overviews reload from snapshots on restart.
  UI cold-load badge (`/api/frozen` + `X-MO-Cold`). Verified end-to-end incl. restart recovery.

## Open
- **S3 retention via bucket lifecycle.** Frozen days are currently dropped by the maintenance sweep
  (RemoveObject). A native S3 lifecycle rule on the `day=` prefix would offload expiry to the provider.
- **Freeze cadence.** Freezing is per local-day at rollover (+ manual `/api/admin/freeze`). Consider an
  hourly intra-day freeze option to shrink the crash-loss window.
- **@mo/tracing polish.** Wider framework coverage / messaging instrumentation examples in the sample.

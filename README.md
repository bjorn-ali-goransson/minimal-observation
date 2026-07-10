# Minimal Observation

A **feather-light distributed-tracing APM** — a tiny Elastic APM + Kibana you can run from one
`docker compose up`. It ingests OpenTelemetry, stores traces in **embedded SQLite** with an
**in-process rollup** layer and an **S3 (or local) frozen tier**, serves a **React** UI, and ships an
**AI investigator**. The whole server is one **~17 MB pure-Go binary** that idles at **~9 MB RAM**.

The design bet: **don't reinvent instrumentation.** Client apps use the OpenTelemetry SDK (framework
middlewares, SQL/fs/messaging instrumentation, distributed trace propagation). Minimal Observation is
the small part worth building — the server, storage, UI, and agent.

## Features

- **Distributed tracing** via OpenTelemetry (TypeScript client). `@mo/tracing` is a one-call setup with
  HTTP **header enrichment**, framework middleware, and a **SQL row-count** hook (`db.statement` + rows).
- **Dependencies as spans**: SQL/DB, external HTTP, messaging, filesystem, plus custom spans/transactions.
- **UI** (minimal Kibana): services → service (endpoints) → endpoint (percentiles, error rate, breakdown,
  charts) → single request **waterfall**; dependencies with top callers; a **custom SQL + chart** view.
- **AI investigator**: "Investigate performance issue" — an agent that pivots from a slow trace to
  similar ones, to the same dependency across services, or fast-vs-slow cohorts. Each pivot is one query.
- **Export** any span set as JSON/CSV. **API-key** auth. **7-day retention** (configurable).

## Quick start

```bash
# 1) Full stack with a MinIO-backed S3 frozen tier
docker compose up          # → UI at http://localhost:4318  (key: dev-secret-key)

# 2) Or run locally (needs Node 22 + Go 1.24; local frozen tier, no S3)
pnpm install
pnpm build                 # UI + tracing + the Go server
pnpm start &               # server on :4318
pnpm seed                  # load demo traces
#   open http://localhost:4318 and enter dev-secret-key

# 3) See real OpenTelemetry data from an instrumented app
pnpm sample                # Express gateway→backend, exports to :4318
```

Enable the AI investigator by setting `ANTHROPIC_API_KEY` (see `.env.example`).

## How storage works (the feather-light part)

| Layer | What | Where |
|------|------|-------|
| Hot | recent unfrozen spans | `spans.sqlite` (small page cache → flat RAM) |
| Rollups | per-hour latency **histograms** | in-process (no engine); overviews & percentiles |
| Frozen | finished days | `day=…/spans.sqlite` + `rollups.json` — local dir **or** S3/MinIO |

SQLite reads through a ~2 MB page cache, so **RSS stays flat as data grows** — no hot/warm/cold tiering
is needed for memory. At day rollover a finished day is **frozen** to a per-day SQLite file (+ a small
rollup snapshot) on the frozen store; its hot rows are deleted. Overviews keep working from the
in-memory rollups (reloaded from the snapshots on restart); drilling into an old trace **downloads and
attaches** that day's file from S3, and it's **evicted after an idle timeout**. The UI shows a
cold-load badge whenever a request draws on frozen storage. Retention drops frozen days past the window.
Anything unflushed on a crash is lost — an explicit, accepted trade.

Measured footprint (same box, ~17.4k spans): **~9 MB idle / ~54 MB loaded**, versus the earlier
Node+DuckDB server at 115 / 232 MB. See [`CLAUDE.md`](./CLAUDE.md) for architecture + gotchas.

## Configuration

Copy `.env.example` → `.env`. Key knobs: `MO_API_KEY`, `MO_PORT`, `MO_DATA_DIR`, `MO_RETENTION_DAYS`,
`MO_COLD_KIND` (`local`|`s3`) + `MO_S3_*`, `MO_COLD_IDLE_MS`, `MO_FLUSH_MAX_ROWS/MS`, `ANTHROPIC_API_KEY`.

## License

MIT

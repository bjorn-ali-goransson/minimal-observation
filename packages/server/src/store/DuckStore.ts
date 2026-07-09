import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BUCKET_COUNT, CREATE_SPANS_TABLE, type Span } from '@mo/shared';
import type { Config } from '../config.js';
import { ColdStore } from './cold.js';
import { openDb, run, all, one, q, type Conn } from './duck.js';
import { dayOf, today, daysBetween, relTableForDay, nextMidnightMs } from './time.js';

const BUCKET_EXPR = (durNs: string) =>
  `CASE WHEN ${durNs} <= 250000 THEN 0 ELSE least(${BUCKET_COUNT - 1}, greatest(0, cast(ceil(ln((${durNs}/1e6)/0.25)/ln(1.5)) AS INTEGER))) END`;

/** Granular hourly rollup row (histogram encoded as parallel bucket/count arrays). */
export interface RollupRow {
  hour_ms: number;
  service: string;
  name: string;
  span_type: string;
  is_transaction: boolean;
  dependency: string | null;
  n: number;
  errors: number;
  sum_dur_ns: number;
  buckets: number[];
  counts: number[];
}

export interface TraceFilter {
  service?: string;
  name?: string;
  fromMs: number;
  toMs: number;
  minDurMs?: number;
  maxDurMs?: number;
  status?: 'OK' | 'ERROR';
  dependency?: string;
  limit?: number;
}

export class DuckStore {
  private conn!: Conn;
  private cold: ColdStore;
  private buffer: Span[] = [];
  private currentDay = today();
  private frozen = new Set<string>(); // days that live in cold storage
  private unpacked = new Map<string, number>(); // day -> lastAccessMs
  private flushTimer?: NodeJS.Timeout;
  private maintTimer?: NodeJS.Timeout;
  private flushing = false;

  constructor(private cfg: Config) {
    this.cold = new ColdStore(cfg);
  }

  async init(): Promise<void> {
    mkdirSync(this.cfg.dataDir, { recursive: true });
    const { conn } = await openDb(join(this.cfg.dataDir, 'warm.duckdb'));
    this.conn = conn;
    await run(conn, `SET memory_limit='512MB'; SET threads=2;`);
    await run(conn, CREATE_SPANS_TABLE('spans'));
    await run(
      conn,
      `CREATE TABLE IF NOT EXISTS rollups(
         hour_ms BIGINT, service VARCHAR, name VARCHAR, span_type VARCHAR,
         is_transaction BOOLEAN, dependency VARCHAR,
         n BIGINT, errors BIGINT, sum_dur_ns DOUBLE, buckets JSON, counts JSON
       )`,
    );
    await run(conn, `CREATE TABLE IF NOT EXISTS frozen_days(day VARCHAR PRIMARY KEY)`);
    await this.cold.init(conn);
    for (const { day } of await all<{ day: string }>(conn, `SELECT day FROM frozen_days`)) this.frozen.add(day);

    this.flushTimer = setInterval(() => void this.flush(), this.cfg.flushMaxMs).unref();
    this.maintTimer = setInterval(() => void this.maintenance(), 60_000).unref();
  }

  // ---- Ingestion -------------------------------------------------------------

  ingest(spans: Span[]): void {
    if (spans.length) this.buffer.push(...spans);
    if (this.buffer.length >= this.cfg.flushMaxRows) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.rolloverIfNeeded();
      const app = await this.conn.createAppender('spans');
      for (const s of batch) {
        app.appendVarchar(s.traceId);
        app.appendVarchar(s.spanId);
        s.parentId ? app.appendVarchar(s.parentId) : app.appendNull();
        app.appendVarchar(s.service);
        s.serviceVersion ? app.appendVarchar(s.serviceVersion) : app.appendNull();
        s.environment ? app.appendVarchar(s.environment) : app.appendNull();
        app.appendVarchar(s.name);
        app.appendVarchar(s.kind);
        app.appendBoolean(s.isTransaction);
        app.appendVarchar(s.spanType);
        s.dependency ? app.appendVarchar(s.dependency) : app.appendNull();
        app.appendBigInt(s.startNs);
        app.appendBigInt(s.endNs);
        app.appendBigInt(s.durNs);
        app.appendVarchar(s.status);
        s.statusMessage ? app.appendVarchar(s.statusMessage) : app.appendNull();
        s.httpMethod ? app.appendVarchar(s.httpMethod) : app.appendNull();
        s.httpStatus !== null ? app.appendInteger(s.httpStatus) : app.appendNull();
        s.dbSystem ? app.appendVarchar(s.dbSystem) : app.appendNull();
        s.dbStatement ? app.appendVarchar(s.dbStatement) : app.appendNull();
        app.appendBigInt(BigInt(s.dbRows));
        app.appendVarchar(JSON.stringify(s.attrs ?? {}));
        app.endRow();
      }
      app.flushSync();
      app.closeSync();
    } finally {
      this.flushing = false;
    }
  }

  // ---- Day rollover, freeze, retention --------------------------------------

  private async rolloverIfNeeded(): Promise<void> {
    const now = today();
    if (now === this.currentDay) return;
    const finished = this.currentDay;
    this.currentDay = now;
    await this.freezeDay(finished);
  }

  /** Freeze `spans` (assumed to hold `day`'s data) to cold Parquet + rollups, then clear. */
  async freezeDay(day: string): Promise<void> {
    const cnt = await one<{ c: number }>(this.conn, `SELECT count(*) c FROM spans`);
    if (!cnt || cnt.c === 0) return;
    await this.cold.freeze(this.conn, day, `SELECT * FROM spans`);
    await this.writeRollups('spans');
    await run(this.conn, `INSERT OR IGNORE INTO frozen_days VALUES (${q(day)})`);
    this.frozen.add(day);
    await run(this.conn, `DELETE FROM spans`);
    await run(this.conn, `CHECKPOINT`);
  }

  private rollupSelect(src: string, whereHourMs?: number): string {
    const where = whereHourMs !== undefined ? `WHERE (start_ns // 3600000000000) * 3600000 >= ${whereHourMs}` : '';
    return `
      SELECT hour_ms, service, name, span_type, is_transaction, dependency,
             sum(c) AS n, sum(errs) AS errors, sum(sd) AS sum_dur_ns,
             to_json(list(bucket)) AS buckets, to_json(list(c)) AS counts
      FROM (
        SELECT (start_ns // 3600000000000) * 3600000 AS hour_ms,
               service, name, span_type, is_transaction, dependency,
               ${BUCKET_EXPR('dur_ns')} AS bucket,
               count(*) AS c,
               sum(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) AS errs,
               sum(dur_ns) AS sd
        FROM ${src} ${where}
        GROUP BY 1,2,3,4,5,6,7
      ) GROUP BY 1,2,3,4,5,6`;
  }

  private async writeRollups(src: string): Promise<void> {
    await run(
      this.conn,
      `INSERT INTO rollups
       SELECT hour_ms, service, name, span_type, is_transaction, dependency, n, errors, sum_dur_ns, buckets, counts
       FROM (${this.rollupSelect(src)})`,
    );
  }

  private async maintenance(): Promise<void> {
    await this.rolloverIfNeeded();
    // Evict idle unpacked cold days.
    const now = Date.now();
    for (const [day, last] of this.unpacked) {
      if (now - last > this.cfg.cold.idleMs) {
        await run(this.conn, `DROP TABLE IF EXISTS ${relTableForDay(day)}`).catch(() => {});
        this.unpacked.delete(day);
      }
    }
    // Retention: drop cold days + rollups older than retention.
    const cutoff = dayOf(now - this.cfg.retentionDays * 86_400_000);
    const frozen = await all<{ day: string }>(this.conn, `SELECT day FROM frozen_days ORDER BY day`);
    for (const { day } of frozen) {
      if (day < cutoff) {
        this.cold.dropDay(day);
        this.frozen.delete(day);
        await run(this.conn, `DELETE FROM frozen_days WHERE day=${q(day)}`);
      }
    }
    const cutoffMs = new Date(cutoff).getTime();
    await run(this.conn, `DELETE FROM rollups WHERE hour_ms < ${cutoffMs}`);
  }

  // ---- Cold unpack -----------------------------------------------------------

  private async ensureUnpacked(day: string): Promise<string | null> {
    // A frozen day lives in cold even if it is still "today" (e.g. a manual freeze).
    if (day === this.currentDay && !this.frozen.has(day)) return 'spans';
    const rel = relTableForDay(day);
    if (this.unpacked.has(day)) {
      this.unpacked.set(day, Date.now());
      return rel;
    }
    if (!this.frozen.has(day) && !(await this.cold.exists(this.conn, day))) return null;
    await run(this.conn, `CREATE TEMP TABLE IF NOT EXISTS ${rel} AS SELECT * FROM ${this.cold.readDay(day)}`);
    this.unpacked.set(day, Date.now());
    return rel;
  }

  /** Build a UNION-ALL relation over raw spans covering [fromMs,toMs]. Null if nothing resident. */
  private async spanSource(fromMs: number, toMs: number): Promise<string | null> {
    const rels: string[] = [];
    for (const day of daysBetween(fromMs, toMs, this.cfg.retentionDays + 1)) {
      const rel = await this.ensureUnpacked(day);
      if (rel && !rels.includes(rel)) rels.push(rel);
    }
    if (rels.length === 0) return null;
    return rels.length === 1 ? rels[0] : `(${rels.map((r) => `SELECT * FROM ${r}`).join(' UNION ALL ')})`;
  }

  // ---- Query API used by routes/agent ---------------------------------------

  /** Hourly rollup rows for [fromMs,toMs] (stored past days + live today), with optional filters. */
  async getRollups(fromMs: number, toMs: number, f: { service?: string; name?: string } = {}): Promise<RollupRow[]> {
    const hourFrom = Math.floor(fromMs / 3_600_000) * 3_600_000;
    const filt = [f.service && `service=${q(f.service)}`, f.name && `name=${q(f.name)}`].filter(Boolean).join(' AND ');
    const filtSql = filt ? `AND ${filt}` : '';
    const stored = await all<RollupRow>(
      this.conn,
      `SELECT * FROM rollups WHERE hour_ms >= ${hourFrom} AND hour_ms <= ${toMs} ${filtSql}`,
    );
    // Live rollups for the current day (spans table), if the range reaches into today.
    let live: RollupRow[] = [];
    if (toMs >= new Date(this.currentDay).getTime()) {
      const liveFilt = filt ? `WHERE ${filt}` : '';
      live = await all<RollupRow>(
        this.conn,
        `SELECT * FROM (${this.rollupSelect('spans', hourFrom)}) ${liveFilt}`,
      );
    }
    return [...stored, ...live].map(parseHist);
  }

  async listServices(fromMs: number, toMs: number): Promise<string[]> {
    const rows = await this.getRollups(fromMs, toMs);
    return [...new Set(rows.map((r) => r.service))].sort();
  }

  /** Transactions (root spans) matching a filter, newest first. */
  async getTraceList(f: TraceFilter): Promise<any[]> {
    const src = await this.spanSource(f.fromMs, f.toMs);
    if (!src) return [];
    const w = [
      `is_transaction`,
      `start_ns >= ${BigInt(Math.floor(f.fromMs)) * 1_000_000n}`,
      `start_ns <= ${BigInt(Math.floor(f.toMs)) * 1_000_000n}`,
      f.service && `service=${q(f.service)}`,
      f.name && `name=${q(f.name)}`,
      f.status && `status=${q(f.status)}`,
      f.minDurMs !== undefined && `dur_ns >= ${Math.floor(f.minDurMs * 1e6)}`,
      f.maxDurMs !== undefined && `dur_ns <= ${Math.floor(f.maxDurMs * 1e6)}`,
    ]
      .filter(Boolean)
      .join(' AND ');
    return all(
      this.conn,
      `SELECT trace_id, span_id, service, name, http_method, http_status, status,
              start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms
       FROM ${src} WHERE ${w}
       ORDER BY start_ns DESC LIMIT ${Math.min(f.limit ?? 100, 1000)}`,
    );
  }

  /** All spans of a trace (for the waterfall). Searches today then cold days newest-first. */
  async getTrace(traceId: string, dayHintMs?: number): Promise<any[]> {
    const nowMs = Date.now();
    const search = dayHintMs
      ? daysBetween(dayHintMs - 86_400_000, dayHintMs + 86_400_000, 3)
      : daysBetween(nowMs - this.cfg.retentionDays * 86_400_000, nowMs, this.cfg.retentionDays + 1).reverse();
    for (const day of search) {
      const rel = await this.ensureUnpacked(day);
      if (!rel) continue;
      const rows = await all(
        this.conn,
        `SELECT trace_id, span_id, parent_id, service, name, kind, span_type, dependency,
                is_transaction, status, status_message, http_method, http_status,
                db_system, db_statement, db_rows,
                start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms, attrs
         FROM ${rel} WHERE trace_id=${q(traceId)} ORDER BY start_ns`,
      );
      if (rows.length) return rows;
    }
    return [];
  }

  async getDependencyTraces(dependency: string, fromMs: number, toMs: number, limit = 100): Promise<any[]> {
    const src = await this.spanSource(fromMs, toMs);
    if (!src) return [];
    return all(
      this.conn,
      `SELECT trace_id, span_id, service, name, dependency, span_type, status,
              db_statement, db_rows, start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms
       FROM ${src} WHERE dependency=${q(dependency)}
         AND start_ns >= ${BigInt(Math.floor(fromMs)) * 1_000_000n}
       ORDER BY start_ns DESC LIMIT ${Math.min(limit, 1000)}`,
    );
  }

  /** Compact span rows for export / AI consumption. */
  async exportSpans(f: TraceFilter): Promise<any[]> {
    const src = await this.spanSource(f.fromMs, f.toMs);
    if (!src) return [];
    const w = [
      `start_ns >= ${BigInt(Math.floor(f.fromMs)) * 1_000_000n}`,
      `start_ns <= ${BigInt(Math.floor(f.toMs)) * 1_000_000n}`,
      f.service && `service=${q(f.service)}`,
      f.name && `name=${q(f.name)}`,
      f.status && `status=${q(f.status)}`,
      f.dependency && `dependency=${q(f.dependency)}`,
      f.minDurMs !== undefined && `dur_ns >= ${Math.floor(f.minDurMs * 1e6)}`,
    ]
      .filter(Boolean)
      .join(' AND ');
    return all(
      this.conn,
      `SELECT trace_id, span_id, parent_id, service, name, kind, span_type, dependency,
              status, db_statement, db_rows, http_method, http_status,
              round(dur_ns/1e6, 3) AS dur_ms, start_ns/1e6 AS start_ms
       FROM ${src} WHERE ${w} ORDER BY start_ns DESC LIMIT ${Math.min(f.limit ?? 500, 5000)}`,
    );
  }

  private timeWhere(fromMs: number, toMs: number): string {
    return `start_ns >= ${BigInt(Math.floor(fromMs)) * 1_000_000n} AND start_ns <= ${BigInt(Math.floor(toMs)) * 1_000_000n}`;
  }

  /** Exact latency/error summary for one endpoint (root spans) from raw data. */
  async getEndpointSummary(service: string, name: string, fromMs: number, toMs: number): Promise<any> {
    const src = await this.spanSource(fromMs, toMs);
    if (!src) return null;
    return one(
      this.conn,
      `SELECT count(*) AS n,
              sum(CASE WHEN status='ERROR' THEN 1 ELSE 0 END) AS errors,
              quantile_cont(dur_ns,0.5)/1e6 AS p50, quantile_cont(dur_ns,0.9)/1e6 AS p90,
              quantile_cont(dur_ns,0.95)/1e6 AS p95, quantile_cont(dur_ns,0.99)/1e6 AS p99,
              avg(dur_ns)/1e6 AS avg, min(dur_ns)/1e6 AS min, max(dur_ns)/1e6 AS max
       FROM ${src}
       WHERE is_transaction AND service=${q(service)} AND name=${q(name)} AND ${this.timeWhere(fromMs, toMs)}`,
    );
  }

  /** Where does this endpoint spend time? Sum child-span durations by type across its traces. */
  async getEndpointBreakdown(service: string, name: string, fromMs: number, toMs: number): Promise<any[]> {
    const src = await this.spanSource(fromMs, toMs);
    if (!src) return [];
    return all(
      this.conn,
      `WITH txn AS (
         SELECT DISTINCT trace_id FROM ${src}
         WHERE is_transaction AND service=${q(service)} AND name=${q(name)} AND ${this.timeWhere(fromMs, toMs)}
         ORDER BY trace_id LIMIT 300)
       SELECT span_type, count(*) AS n, sum(dur_ns)/1e6 AS ms
       FROM ${src} WHERE trace_id IN (SELECT trace_id FROM txn)
       GROUP BY span_type ORDER BY ms DESC`,
    );
  }

  /** Most frequent endpoints (transactions) that call a given dependency. */
  async getDependencyEndpoints(dependency: string, fromMs: number, toMs: number): Promise<any[]> {
    const src = await this.spanSource(fromMs, toMs);
    if (!src) return [];
    return all(
      this.conn,
      `WITH dep AS (
         SELECT DISTINCT trace_id FROM ${src}
         WHERE dependency=${q(dependency)} AND ${this.timeWhere(fromMs, toMs)} LIMIT 500)
       SELECT service, name, count(*) AS n, avg(dur_ns)/1e6 AS avg_ms
       FROM ${src} WHERE is_transaction AND trace_id IN (SELECT trace_id FROM dep)
       GROUP BY service, name ORDER BY n DESC LIMIT 20`,
    );
  }

  /** Read-only custom query. Whitelist a single SELECT; everything else rejected. */
  async runReadOnlySql(sql: string): Promise<{ columns: string[]; rows: any[] }> {
    const trimmed = sql.trim().replace(/;+\s*$/, '');
    if (!/^(select|with|pivot|summarize)\b/i.test(trimmed)) throw new Error('Only read-only SELECT/WITH queries are allowed');
    if (/\b(insert|update|delete|drop|create|alter|attach|copy|install|load|pragma|export|import|call)\b/i.test(trimmed))
      throw new Error('Query contains a disallowed keyword');
    // Expose a friendly `spans` view spanning the full retention window.
    const src = (await this.spanSource(Date.now() - this.cfg.retentionDays * 86_400_000, Date.now())) ?? 'spans';
    const wrapped = `WITH spans AS (SELECT * FROM ${src}) ${trimmed} LIMIT 5000`;
    const reader = await this.conn.runAndReadAll(wrapped);
    const columns = reader.columnNames();
    const rows = (await all(this.conn, wrapped)) as any[];
    return { columns, rows };
  }

  // ---- lifecycle -------------------------------------------------------------

  async shutdown(): Promise<void> {
    clearInterval(this.flushTimer);
    clearInterval(this.maintTimer);
    await this.flush();
  }

  /** Test/ops hook: force-freeze the current day under a label and start fresh. */
  async forceFreeze(day = this.currentDay): Promise<void> {
    await this.flush();
    await this.freezeDay(day);
  }

  get connection(): Conn {
    return this.conn;
  }
  get currentDayLabel(): string {
    return this.currentDay;
  }
  msUntilMidnight(): number {
    return nextMidnightMs(Date.now()) - Date.now();
  }
}

function parseHist(r: any): RollupRow {
  return {
    ...r,
    is_transaction: !!r.is_transaction,
    buckets: typeof r.buckets === 'string' ? JSON.parse(r.buckets) : r.buckets ?? [],
    counts: typeof r.counts === 'string' ? JSON.parse(r.counts) : r.counts ?? [],
  };
}

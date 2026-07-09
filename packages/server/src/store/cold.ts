import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.js';
import { all, run, type Conn, q } from './duck.js';

/**
 * The COLD tier: frozen, immutable, day-partitioned Parquet.
 * Two interchangeable backends behind one path abstraction:
 *   - local: Parquet files under <dataDir>/cold/day=YYYY-MM-DD/data.parquet
 *   - s3:    s3://<bucket>/day=YYYY-MM-DD/data.parquet  (MinIO or real S3 via httpfs)
 * Reads go through DuckDB read_parquet in both cases, so the query layer is identical.
 */
export class ColdStore {
  private base: string;

  constructor(private cfg: Config) {
    this.base = cfg.cold.kind === 's3' ? `s3://${cfg.cold.s3.bucket}` : join(cfg.dataDir, 'cold');
  }

  /** Prepare the backend on a connection: httpfs + S3 secret, or local dir. */
  async init(conn: Conn): Promise<void> {
    if (this.cfg.cold.kind === 's3') {
      const s = this.cfg.cold.s3;
      await run(conn, `INSTALL httpfs; LOAD httpfs;`);
      const host = s.endpoint.replace(/^https?:\/\//, '');
      const useSsl = s.endpoint.startsWith('https');
      await run(
        conn,
        `CREATE OR REPLACE SECRET mo_s3 (
           TYPE S3,
           KEY_ID ${q(s.accessKey)},
           SECRET ${q(s.secretKey)},
           REGION ${q(s.region)},
           ENDPOINT ${q(host)},
           URL_STYLE ${q(s.urlStyle)},
           USE_SSL ${useSsl}
         )`,
      );
    } else {
      mkdirSync(this.base, { recursive: true });
    }
  }

  dayGlob(day: string): string {
    return `${this.base}/day=${day}/data.parquet`;
  }

  /** DuckDB read expression for one cold day; returns null-safe SQL if the day is absent. */
  readDay(day: string): string {
    return `read_parquet(${q(this.dayGlob(day))})`;
  }

  /** Freeze a source relation (query) into a day partition. */
  async freeze(conn: Conn, day: string, selectSql: string): Promise<void> {
    if (this.cfg.cold.kind === 'local') {
      mkdirSync(join(this.base, `day=${day}`), { recursive: true });
    }
    await run(conn, `COPY (${selectSql}) TO ${q(this.dayGlob(day))} (FORMAT PARQUET, COMPRESSION ZSTD)`);
  }

  /** List frozen days present in cold storage. */
  async listDays(conn: Conn): Promise<string[]> {
    try {
      const rows = await all<{ day: string }>(
        conn,
        `SELECT DISTINCT regexp_extract(file, 'day=([0-9-]+)', 1) AS day
         FROM glob(${q(`${this.base}/day=*/data.parquet`)}) t(file)
         WHERE day <> '' ORDER BY day`,
      );
      return rows.map((r) => r.day);
    } catch {
      return [];
    }
  }

  async exists(conn: Conn, day: string): Promise<boolean> {
    if (this.cfg.cold.kind === 'local') return existsSync(join(this.base, `day=${day}`, 'data.parquet'));
    return (await this.listDays(conn)).includes(day);
  }

  /** Drop a day past retention. Local: delete dir. S3: rely on bucket lifecycle policy. */
  dropDay(day: string): void {
    if (this.cfg.cold.kind === 'local') {
      const dir = join(this.base, `day=${day}`);
      if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
  }
}

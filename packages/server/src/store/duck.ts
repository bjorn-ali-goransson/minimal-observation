import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';

export type Conn = DuckDBConnection;

export async function openDb(path: string): Promise<{ instance: DuckDBInstance; conn: Conn }> {
  const instance = await DuckDBInstance.create(path);
  const conn = await instance.connect();
  return { instance, conn };
}

export async function run(conn: Conn, sql: string): Promise<void> {
  await conn.run(sql);
}

/**
 * Run a query and return plain row objects. BIGINT columns come back as JS bigint;
 * we down-convert to Number for JSON friendliness. Callers must therefore never
 * SELECT raw epoch-nanosecond BIGINTs (they exceed MAX_SAFE_INTEGER) — select
 * `col/1e6` as a DOUBLE millisecond value instead.
 */
export async function all<T = Record<string, unknown>>(conn: Conn, sql: string): Promise<T[]> {
  const reader = await conn.runAndReadAll(sql);
  const rows = reader.getRowObjects();
  return rows.map(normalizeRow) as T[];
}

export async function one<T = Record<string, unknown>>(conn: Conn, sql: string): Promise<T | undefined> {
  return (await all<T>(conn, sql))[0];
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

/** Single-quote escape for inlining literals (we control all SQL; values are escaped). */
export function q(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}

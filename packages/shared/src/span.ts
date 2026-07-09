/**
 * The one canonical row shape the whole platform speaks.
 *
 * OpenTelemetry only has "spans with a kind". The APM concepts users think in —
 * services, transactions, dependencies — are *derived* here so the rest of the
 * system (storage, query, UI, agent) never has to re-derive them:
 *
 *   service      = OTel resource attribute `service.name`
 *   transaction  = a root/entry span (kind SERVER or CONSUMER) — see `isTransaction`
 *   dependency   = an outbound span (kind CLIENT or PRODUCER) — see `dependency`
 *   custom span  = anything else (kind INTERNAL)
 */

export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER';
export type SpanStatus = 'UNSET' | 'OK' | 'ERROR';

/** Coarse classification used for the "performance breakdown" and dependency views. */
export type SpanType =
  | 'http' // inbound http (transaction)
  | 'external' // outbound http/rpc
  | 'db' // sql / nosql
  | 'messaging' // queue produce/consume
  | 'fs' // filesystem access
  | 'internal'; // custom timespan / app code

export interface Span {
  traceId: string;
  spanId: string;
  parentId: string | null;

  service: string;
  serviceVersion: string | null;
  environment: string | null;

  name: string;
  kind: SpanKind;
  /** Root entry span: what Elastic APM calls a "transaction". */
  isTransaction: boolean;
  spanType: SpanType;
  /** For CLIENT/PRODUCER spans: the resource being depended on (e.g. `postgresql:orders`, `GET api.stripe.com`). */
  dependency: string | null;

  /** Epoch nanoseconds. */
  startNs: bigint;
  endNs: bigint;
  durNs: bigint;

  status: SpanStatus;
  statusMessage: string | null;

  httpMethod: string | null;
  httpStatus: number | null;

  dbSystem: string | null;
  dbStatement: string | null;
  /** Rows returned, or — for streamed/cursor results — rows iterated through. -1 if unknown. */
  dbRows: number;

  /** Full attribute bag, minus the columns promoted above. Stored as JSON. */
  attrs: Record<string, unknown>;
}

/** Columns, in the exact order the DuckDB appender writes them. Single source of truth. */
export const SPAN_COLUMNS = [
  ['trace_id', 'VARCHAR'],
  ['span_id', 'VARCHAR'],
  ['parent_id', 'VARCHAR'],
  ['service', 'VARCHAR'],
  ['service_version', 'VARCHAR'],
  ['environment', 'VARCHAR'],
  ['name', 'VARCHAR'],
  ['kind', 'VARCHAR'],
  ['is_transaction', 'BOOLEAN'],
  ['span_type', 'VARCHAR'],
  ['dependency', 'VARCHAR'],
  ['start_ns', 'BIGINT'],
  ['end_ns', 'BIGINT'],
  ['dur_ns', 'BIGINT'],
  ['status', 'VARCHAR'],
  ['status_message', 'VARCHAR'],
  ['http_method', 'VARCHAR'],
  ['http_status', 'INTEGER'],
  ['db_system', 'VARCHAR'],
  ['db_statement', 'VARCHAR'],
  ['db_rows', 'BIGINT'],
  ['attrs', 'JSON'],
] as const;

export const CREATE_SPANS_TABLE = (name = 'spans') =>
  `CREATE TABLE IF NOT EXISTS ${name} (\n  ` +
  SPAN_COLUMNS.map(([c, t]) => `${c} ${t}`).join(',\n  ') +
  `\n)`;

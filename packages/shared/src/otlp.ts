import type { Span, SpanKind, SpanStatus, SpanType } from './span.js';

/**
 * Decode an OTLP/HTTP trace export payload (JSON encoding) into canonical Spans.
 * Tolerant of both hex and base64 id encodings, since different OTel exporters differ.
 */

type AnyVal = {
  stringValue?: string;
  intValue?: string | number;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values?: AnyVal[] };
  kvlistValue?: { values?: KV[] };
};
type KV = { key: string; value?: AnyVal };

function val(v?: AnyVal): unknown {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return typeof v.intValue === 'string' ? Number(v.intValue) : v.intValue;
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.arrayValue) return (v.arrayValue.values ?? []).map(val);
  if (v.kvlistValue) return attrsToObject(v.kvlistValue.values ?? []);
  return undefined;
}

function attrsToObject(kvs: KV[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const kv of kvs) if (kv?.key !== undefined) out[kv.key] = val(kv.value);
  return out;
}

const HEX = /^[0-9a-fA-F]+$/;
function normId(id: string | undefined): string {
  if (!id) return '';
  if (HEX.test(id) && (id.length === 32 || id.length === 16 || id.length === 0)) return id.toLowerCase();
  // assume base64 -> hex
  try {
    return Buffer.from(id, 'base64').toString('hex');
  } catch {
    return id;
  }
}

const KIND: SpanKind[] = ['INTERNAL', 'INTERNAL', 'SERVER', 'CLIENT', 'PRODUCER', 'CONSUMER'];

function pick(a: Record<string, unknown>, ...keys: string[]): unknown {
  for (const k of keys) if (a[k] !== undefined && a[k] !== null) return a[k];
  return undefined;
}
function str(x: unknown): string | null {
  return x === undefined || x === null ? null : String(x);
}
function num(x: unknown): number | null {
  const n = Number(x);
  return x === undefined || x === null || Number.isNaN(n) ? null : n;
}

function classify(kind: SpanKind, a: Record<string, unknown>, name: string): SpanType {
  if (a['db.system'] !== undefined) return 'db';
  if (a['messaging.system'] !== undefined) return 'messaging';
  if (name.startsWith('fs ') || a['fs.operation'] !== undefined || a['code.function.fs'] !== undefined) return 'fs';
  const hasHttp = a['http.request.method'] ?? a['http.method'] ?? a['url.full'] ?? a['url.path'] ?? a['rpc.system'];
  if (kind === 'SERVER' || kind === 'CONSUMER') return hasHttp ? 'http' : 'internal';
  if (kind === 'CLIENT' || kind === 'PRODUCER') return hasHttp ? 'external' : 'internal';
  return 'internal';
}

function depName(type: SpanType, a: Record<string, unknown>, name: string): string | null {
  switch (type) {
    case 'db': {
      const sys = str(a['db.system']) ?? 'db';
      const db = str(pick(a, 'db.name', 'db.namespace'));
      return db ? `${sys}:${db}` : sys;
    }
    case 'messaging': {
      const sys = str(a['messaging.system']) ?? 'queue';
      const dest = str(pick(a, 'messaging.destination.name', 'messaging.destination'));
      return dest ? `${sys}:${dest}` : sys;
    }
    case 'external': {
      const method = str(pick(a, 'http.request.method', 'http.method'));
      const host = str(pick(a, 'server.address', 'net.peer.name', 'url.host', 'peer.service'));
      if (host) return method ? `${method} ${host}` : host;
      return name;
    }
    case 'fs':
      return 'filesystem';
    default:
      return null;
  }
}

export interface OtlpParseResult {
  spans: Span[];
  accepted: number;
}

export function parseOtlpTraces(body: unknown): OtlpParseResult {
  const spans: Span[] = [];
  const root = (body ?? {}) as { resourceSpans?: any[] };
  for (const rs of root.resourceSpans ?? []) {
    const resAttrs = attrsToObject(rs?.resource?.attributes ?? []);
    const service = str(pick(resAttrs, 'service.name')) ?? 'unknown';
    const serviceVersion = str(pick(resAttrs, 'service.version'));
    const environment = str(pick(resAttrs, 'deployment.environment.name', 'deployment.environment'));
    for (const ss of rs?.scopeSpans ?? rs?.instrumentationLibrarySpans ?? []) {
      for (const s of ss?.spans ?? []) {
        const a = attrsToObject(s?.attributes ?? []);
        const kind = KIND[s?.kind ?? 0] ?? 'INTERNAL';
        const name = String(s?.name ?? '');
        const startNs = BigInt(s?.startTimeUnixNano ?? 0);
        const endNs = BigInt(s?.endTimeUnixNano ?? 0);
        const spanType = classify(kind, a, name);
        const httpStatus = num(pick(a, 'http.response.status_code', 'http.status_code'));
        const statusCode = s?.status?.code ?? 0;
        let status: SpanStatus = statusCode === 2 ? 'ERROR' : statusCode === 1 ? 'OK' : 'UNSET';
        if (status !== 'ERROR' && httpStatus !== null && httpStatus >= 500) status = 'ERROR';
        const dbRows = num(
          pick(a, 'db.rows_iterated', 'db.response.returned_rows', 'db.result.rows', 'db.rows_affected'),
        );
        spans.push({
          traceId: normId(s?.traceId),
          spanId: normId(s?.spanId),
          parentId: s?.parentSpanId ? normId(s.parentSpanId) : null,
          service,
          serviceVersion,
          environment,
          name,
          kind,
          isTransaction: kind === 'SERVER' || kind === 'CONSUMER',
          spanType,
          dependency: kind === 'CLIENT' || kind === 'PRODUCER' ? depName(spanType, a, name) : null,
          startNs,
          endNs,
          durNs: endNs > startNs ? endNs - startNs : 0n,
          status,
          statusMessage: str(s?.status?.message),
          httpMethod: str(pick(a, 'http.request.method', 'http.method')),
          httpStatus,
          dbSystem: str(a['db.system']),
          dbStatement: str(pick(a, 'db.statement', 'db.query.text')),
          dbRows: dbRows ?? -1,
          attrs: a,
        });
      }
    }
  }
  return { spans, accepted: spans.length };
}

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { trace, type Span, SpanStatusCode, SpanKind } from '@opentelemetry/api';

export interface TracingOptions {
  serviceName: string;
  serviceVersion?: string;
  environment?: string;
  /** Minimal Observation ingest endpoint, e.g. http://localhost:4318 */
  endpoint?: string;
  apiKey?: string;
  /** Request headers to attach to server spans as `http.request.header.<name>`. */
  captureRequestHeaders?: string[];
  captureResponseHeaders?: string[];
  /** Enable filesystem-access spans (noisy; off by default). */
  captureFs?: boolean;
}

/**
 * One call to instrument a Node service. Uses OpenTelemetry auto-instrumentation for
 * HTTP and popular frameworks (Express, Fastify, Koa, Nest, Hapi, ...), SQL drivers
 * (pg, mysql2, ...), and messaging, then exports OTLP/HTTP JSON to Minimal Observation.
 *
 * Call BEFORE importing your app (e.g. `node --import @mo/tracing/register`), or at the
 * very top of your entrypoint.
 */
export function startTracing(opts: TracingOptions): NodeSDK {
  const endpoint = opts.endpoint ?? process.env.MO_ENDPOINT ?? 'http://localhost:4318';
  const apiKey = opts.apiKey ?? process.env.MO_API_KEY ?? 'dev-secret-key';

  const exporter = new OTLPTraceExporter({
    url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
    headers: { 'x-api-key': apiKey },
  });

  const reqHeaders = opts.captureRequestHeaders ?? ['user-agent', 'x-request-id', 'x-forwarded-for'];
  const resHeaders = opts.captureResponseHeaders ?? [];

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: opts.serviceName,
      [ATTR_SERVICE_VERSION]: opts.serviceVersion ?? '0.0.0',
      'deployment.environment.name': opts.environment ?? process.env.NODE_ENV ?? 'development',
    }),
    traceExporter: exporter,
    instrumentations: [
      getNodeAutoInstrumentations({
        // HTTP header enrichment.
        '@opentelemetry/instrumentation-http': {
          headersToSpanAttributes: {
            server: { requestHeaders: reqHeaders, responseHeaders: resHeaders },
            client: { requestHeaders: reqHeaders },
          },
        },
        // Capture SQL rows returned for Postgres (streamed/cursor results won't have rowCount;
        // instrument those manually with `recordDbRows`).
        '@opentelemetry/instrumentation-pg': {
          enhancedDatabaseReporting: true,
          responseHook: (span: Span, res: any) => {
            const rows = res?.data?.rowCount ?? res?.rowCount;
            if (typeof rows === 'number') span.setAttribute('db.rows_iterated', rows);
          },
        },
        '@opentelemetry/instrumentation-mysql2': { responseHook: undefined },
        '@opentelemetry/instrumentation-fs': { enabled: !!opts.captureFs },
      }),
    ],
  });

  sdk.start();
  process.once('SIGTERM', () => void sdk.shutdown());
  return sdk;
}

/** Wrap a block in a custom span (a "dependency" if kind=CLIENT, else an internal timespan). */
export async function withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, opts: { kind?: SpanKind; attributes?: Record<string, any> } = {}): Promise<T> {
  const tracer = trace.getTracer('@mo/tracing');
  return tracer.startActiveSpan(name, { kind: opts.kind ?? SpanKind.INTERNAL, attributes: opts.attributes }, async (span) => {
    try {
      const out = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return out;
    } catch (e: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: e?.message });
      span.recordException(e);
      throw e;
    } finally {
      span.end();
    }
  });
}

/** Start a custom root transaction (SERVER kind) for non-HTTP entry points (jobs, consumers). */
export function startTransaction<T>(name: string, fn: (span: Span) => Promise<T> | T, attributes?: Record<string, any>): Promise<T> {
  return withSpan(name, fn, { kind: SpanKind.SERVER, attributes });
}

/** Manually record rows iterated for a streamed/cursor query on the active span. */
export function recordDbRows(count: number): void {
  trace.getActiveSpan()?.setAttribute('db.rows_iterated', count);
}

export { SpanKind, SpanStatusCode } from '@opentelemetry/api';

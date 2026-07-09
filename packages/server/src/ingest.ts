import type { FastifyInstance } from 'fastify';
import { parseOtlpTraces } from '@mo/shared';
import type { DuckStore } from './store/DuckStore.js';
import { requireApiKey } from './auth.js';

/**
 * OTLP/HTTP trace ingestion (JSON encoding).
 * Point an OpenTelemetry OTLPTraceExporter (http/json) at POST /v1/traces with the API key.
 */
export function registerIngest(app: FastifyInstance, store: DuckStore): void {
  app.post('/v1/traces', { preHandler: requireApiKey }, async (req, reply) => {
    const { spans, accepted } = parseOtlpTraces(req.body);
    store.ingest(spans);
    // OTLP success response shape.
    return reply.code(200).send({ partialSuccess: accepted ? {} : {} });
  });
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

/** Accepts `x-api-key: <key>` or `Authorization: ApiKey <key>` / `Bearer <key>`. */
export function extractKey(req: FastifyRequest): string | undefined {
  const h = req.headers;
  const x = h['x-api-key'];
  if (typeof x === 'string' && x) return x;
  const auth = h['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^(?:ApiKey|Bearer)\s+(.+)$/i);
    if (m) return m[1];
  }
  // Query-param fallback, only useful for browser <a download> links (no custom headers).
  const k = (req.query as Record<string, string> | undefined)?.k;
  if (typeof k === 'string' && k) return k;
  return undefined;
}

export async function requireApiKey(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (extractKey(req) !== config.apiKey) {
    await reply.code(401).send({ error: 'unauthorized', detail: 'valid API key required' });
  }
}

/** Seeds a small deterministic trace set over HTTP so the UI has data to render. */
const BASE = process.env.MO_BASE_URL || 'http://localhost:4318';
const KEY = process.env.MO_API_KEY || 'dev-secret-key';

const hex = (seed: number, n: number) =>
  Array.from({ length: n }, (_, i) => (((seed * 9301 + 49297 * (i + 1)) % 233280) % 16).toString(16)).join('');

export default async function globalSetup() {
  const now = Date.now();
  const spans: any[] = [];
  const push = (service: string, s: any) => spans.push({ service, ...s });

  for (let i = 0; i < 40; i++) {
    const traceId = hex(i + 1, 32);
    const t0 = now - (i * 30_000 + 5_000); // spread over ~20 min
    const dur = 40 + (i % 5) * 30 + (i % 7 === 0 ? 300 : 0);
    const err = i % 13 === 0;
    const gw = hex(i + 100, 16);
    push('api-gateway', { traceId, spanId: gw, name: 'GET /api/cart', kind: 2, startMs: t0, durMs: dur + 5, status: err ? 2 : 1, attrs: { 'http.request.method': 'GET', 'url.path': '/api/cart', 'http.response.status_code': err ? 500 : 200 } });
    const call = hex(i + 200, 16);
    push('api-gateway', { traceId, spanId: call, parentSpanId: gw, name: 'POST checkout-service', kind: 3, startMs: t0 + 1, durMs: dur, status: err ? 2 : 1, attrs: { 'http.request.method': 'POST', 'server.address': 'checkout-service' } });
    const svc = hex(i + 300, 16);
    push('checkout-service', { traceId, spanId: svc, parentSpanId: call, name: 'GET /api/cart', kind: 2, startMs: t0 + 2, durMs: dur - 2, status: err ? 2 : 1, attrs: { 'http.request.method': 'GET', 'url.path': '/api/cart' } });
    push('checkout-service', { traceId, spanId: hex(i + 400, 16), parentSpanId: svc, name: 'SELECT products', kind: 3, startMs: t0 + 4, durMs: 8 + (i % 4) * 4, status: 1, attrs: { 'db.system': 'postgresql', 'db.name': 'shop', 'db.statement': 'SELECT * FROM products WHERE category = $1', 'db.rows_iterated': 10 + i } });
  }

  const byService = new Map<string, any[]>();
  for (const s of spans) (byService.get(s.service) ?? byService.set(s.service, []).get(s.service)!).push(s);
  const payload = {
    resourceSpans: [...byService.entries()].map(([service, ss]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [
        {
          scope: { name: 'e2e' },
          spans: ss.map((s) => ({
            traceId: s.traceId,
            spanId: s.spanId,
            parentSpanId: s.parentSpanId,
            name: s.name,
            kind: s.kind,
            startTimeUnixNano: String(Math.floor(s.startMs) * 1_000_000),
            endTimeUnixNano: String(Math.floor(s.startMs + s.durMs) * 1_000_000),
            status: { code: s.status },
            attributes: Object.entries(s.attrs).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) } })),
          })),
        },
      ],
    })),
  };

  const res = await fetch(`${BASE}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
  // Give the micro-batch a moment to flush to the warm store.
  await new Promise((r) => setTimeout(r, 2500));
}

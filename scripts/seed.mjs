/**
 * Synthetic OTLP trace generator — standalone (no deps), posts OTLP/HTTP JSON to /v1/traces.
 *   pnpm seed                    # ~400 traces over the last 2h to localhost:4318
 *   MO_SEED_TRACES=50 pnpm seed
 */
const TARGET = process.env.MO_TARGET || 'http://localhost:4318';
const KEY = process.env.MO_API_KEY || 'dev-secret-key';
const N = Number(process.env.MO_SEED_TRACES || 400);
const WINDOW_MS = Number(process.env.MO_SEED_WINDOW_MS || 2 * 3_600_000);

const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const gauss = (mean, sd) => {
  const u = 1 - Math.random(), v = Math.random();
  return Math.max(1, mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
};

const ENDPOINTS = [
  { name: 'GET /api/cart', mean: 40, sd: 20 },
  { name: 'POST /api/checkout', mean: 180, sd: 120 },
  { name: 'GET /api/products', mean: 60, sd: 30 },
  { name: 'GET /api/orders/:id', mean: 90, sd: 200 },
];
const STATEMENTS = [
  'SELECT * FROM products WHERE category = $1',
  'SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC',
  'INSERT INTO orders (user_id, total) VALUES ($1, $2)',
  'UPDATE inventory SET qty = qty - $1 WHERE sku = $2',
];

function build() {
  const spans = [];
  const now = Date.now();
  const push = (service, s) => spans.push({ service, ...s });
  for (let i = 0; i < N; i++) {
    const t0 = now - Math.random() * WINDOW_MS;
    const traceId = hex(32);
    const ep = pick(ENDPOINTS);
    const slow = Math.random() < 0.08;
    const rootDur = gauss(ep.mean, ep.sd) * (slow ? 4 : 1);
    const isErr = Math.random() < (ep.name.includes('checkout') ? 0.06 : 0.02);
    const gw = hex(16), call = hex(16), svc = hex(16);
    push('api-gateway', { traceId, spanId: gw, name: ep.name, kind: 2, startMs: t0, durMs: rootDur + 5, status: isErr ? 2 : 1, attrs: { 'http.request.method': ep.name.split(' ')[0], 'url.path': ep.name.split(' ')[1], 'http.response.status_code': isErr ? 500 : 200, 'client.address': `10.0.0.${i % 255}` } });
    push('api-gateway', { traceId, spanId: call, parentSpanId: gw, name: 'POST checkout-service', kind: 3, startMs: t0 + 2, durMs: rootDur, status: isErr ? 2 : 1, attrs: { 'http.request.method': 'POST', 'server.address': 'checkout-service', 'http.response.status_code': isErr ? 500 : 200 } });
    push('checkout-service', { traceId, spanId: svc, parentSpanId: call, name: ep.name, kind: 2, startMs: t0 + 3, durMs: rootDur - 2, status: isErr ? 2 : 1, attrs: { 'http.request.method': ep.name.split(' ')[0], 'url.path': ep.name.split(' ')[1], 'http.response.status_code': isErr ? 500 : 200 } });
    let cursor = t0 + 5;
    for (let d = 0, nDb = 1 + Math.floor(Math.random() * 3); d < nDb; d++) {
      const stmt = pick(STATEMENTS);
      const dur = gauss(12, 10) * (slow && d === 0 ? 6 : 1);
      const rows = stmt.startsWith('SELECT') ? Math.floor(Math.random() * 500) : Math.floor(Math.random() * 5);
      push('checkout-service', { traceId, spanId: hex(16), parentSpanId: svc, name: `${stmt.split(' ')[0]} orders`, kind: 3, startMs: cursor, durMs: dur, status: 1, attrs: { 'db.system': 'postgresql', 'db.name': 'shop', 'db.statement': stmt, 'db.rows_iterated': rows } });
      cursor += dur;
    }
    if (Math.random() < 0.5) {
      const dur = gauss(35, 25);
      push('checkout-service', { traceId, spanId: hex(16), parentSpanId: svc, name: 'GET api.stripe.com', kind: 3, startMs: cursor, durMs: dur, status: Math.random() < 0.03 ? 2 : 1, attrs: { 'http.request.method': 'GET', 'server.address': 'api.stripe.com', 'url.full': 'https://api.stripe.com/v1/charges', 'http.response.status_code': 200 } });
      cursor += dur;
    }
    if (Math.random() < 0.3) push('checkout-service', { traceId, spanId: hex(16), parentSpanId: svc, name: 'fs readFileSync', kind: 1, startMs: cursor, durMs: gauss(3, 2), status: 1, attrs: { 'fs.operation': 'readFileSync' } });
  }
  return spans;
}

function toOtlp(spans) {
  const byService = new Map();
  for (const s of spans) (byService.get(s.service) ?? byService.set(s.service, []).get(s.service)).push(s);
  return {
    resourceSpans: [...byService.entries()].map(([service, ss]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'deployment.environment.name', value: { stringValue: 'demo' } }] },
      scopeSpans: [{
        scope: { name: 'mo-seed' },
        spans: ss.map((s) => ({
          traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, name: s.name, kind: s.kind,
          startTimeUnixNano: String(Math.floor(s.startMs) * 1_000_000), endTimeUnixNano: String(Math.floor(s.startMs + s.durMs) * 1_000_000),
          status: { code: s.status },
          attributes: Object.entries(s.attrs).map(([key, value]) => ({ key, value: typeof value === 'number' ? { intValue: String(value) } : { stringValue: String(value) } })),
        })),
      }],
    })),
  };
}

const spans = build();
const res = await fetch(`${TARGET}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify(toOtlp(spans)) });
if (!res.ok) { console.error(`seed failed: ${res.status} ${await res.text()}`); process.exit(1); }
console.log(`seeded ${spans.length} spans across ${new Set(spans.map((s) => s.traceId)).size} traces -> ${TARGET}`);

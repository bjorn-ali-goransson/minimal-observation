/**
 * Sample instrumented service — proves the real OpenTelemetry path end-to-end.
 * Runs a "gateway" (:3001) and a "backend" (:3002) in one process; the gateway
 * calls the backend over HTTP, so you get a genuine DISTRIBUTED trace spanning
 * two services, with Express middleware + HTTP header enrichment + custom db spans.
 *
 *   MO_ENDPOINT=http://localhost:4318 MO_API_KEY=dev-secret-key pnpm sample
 */
async function main() {
  const { startTracing, withSpan, recordDbRows, SpanKind } = await import('@mo/tracing');

  // Start tracing BEFORE requiring instrumented libraries (CJS require-patching).
  startTracing({
    serviceName: 'sample-gateway',
    environment: 'demo',
    captureRequestHeaders: ['user-agent', 'x-request-id'],
  });

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const express = require('express');
  const http = require('http');

  const GATEWAY = Number(process.env.SAMPLE_GATEWAY_PORT || 3001);
  const BACKEND = Number(process.env.SAMPLE_BACKEND_PORT || 3002);

  // ---- backend service ----
  const backend = express();
  backend.get('/products', async (_req: any, res: any) => {
    const rows = await withSpan(
      'SELECT products',
      async () => {
        await sleep(8 + Math.random() * 20);
        const n = Math.floor(Math.random() * 200);
        recordDbRows(n); // rows iterated (works for streamed results too)
        return n;
      },
      { kind: SpanKind.CLIENT, attributes: { 'db.system': 'postgresql', 'db.name': 'shop', 'db.statement': 'SELECT * FROM products WHERE category = $1' } },
    );
    res.json({ count: rows });
  });
  backend.post('/checkout', express.json(), async (_req: any, res: any) => {
    await withSpan('INSERT orders', async () => {
      await sleep(10 + Math.random() * 30);
      recordDbRows(1);
    }, { kind: SpanKind.CLIENT, attributes: { 'db.system': 'postgresql', 'db.name': 'shop', 'db.statement': 'INSERT INTO orders (user_id, total) VALUES ($1, $2)' } });
    if (Math.random() < 0.05) return res.status(500).json({ error: 'payment declined' });
    res.json({ ok: true });
  });
  backend.listen(BACKEND, () => console.log(`backend on :${BACKEND}`));

  // ---- gateway service (calls backend => distributed trace) ----
  const gateway = express();
  const call = (path: string, method = 'GET') =>
    new Promise<void>((resolve) => {
      const req = http.request({ host: 'localhost', port: BACKEND, path, method }, (r: any) => {
        r.resume();
        r.on('end', resolve);
      });
      req.end();
    });
  gateway.get('/api/products', async (_req: any, res: any) => {
    await call('/products');
    res.json({ ok: true });
  });
  gateway.post('/api/checkout', async (_req: any, res: any) => {
    await call('/products');
    await call('/checkout', 'POST');
    res.json({ ok: true });
  });
  gateway.listen(GATEWAY, () => console.log(`gateway on :${GATEWAY} — instrumented, exporting to ${process.env.MO_ENDPOINT || 'http://localhost:4318'}`));

  // ---- built-in traffic driver so you see data immediately ----
  const drive = async () => {
    try {
      await httpGet(GATEWAY, Math.random() < 0.5 ? '/api/products' : '/api/checkout', Math.random() < 0.5 ? 'POST' : 'GET');
    } catch {
      /* ignore */
    }
  };
  setInterval(drive, 300);
  console.log('traffic driver running (every 300ms). Ctrl-C to stop.');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function httpGet(port: number, path: string, method: string) {
  const http = require('http');
  return new Promise<void>((resolve, reject) => {
    const req = http.request({ host: 'localhost', port, path, method }, (r: any) => {
      r.resume();
      r.on('end', () => resolve());
    });
    req.on('error', reject);
    req.end();
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

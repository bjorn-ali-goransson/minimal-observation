import { test, expect, request } from '@playwright/test';

/**
 * Exercises the cold tier: freeze the current day to object storage (S3/MinIO in the
 * compose stack, local Parquet otherwise), then confirm the overview is still served
 * from rollups and that raw spans are read back by unpacking cold storage.
 *
 * Gated behind MO_TEST_COLD=1 because a freeze empties the live table and would
 * otherwise perturb the shared UI smoke run.
 */
const KEY = process.env.MO_API_KEY || 'dev-secret-key';
const BASE = process.env.MO_BASE_URL || 'http://localhost:4318';

test.skip(!process.env.MO_TEST_COLD, 'set MO_TEST_COLD=1 to run the cold-tier freeze test');

test('freeze to cold storage and read back', async () => {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { 'x-api-key': KEY } });
  const now = Date.now();
  const from = now - 3_600_000;

  const before = await (await ctx.get(`/api/services?from=${from}&to=${now}`)).json();
  expect(before.length).toBeGreaterThan(0);
  const totalBefore = before.reduce((a: number, s: any) => a + s.count, 0);

  const freeze = await (await ctx.post('/api/admin/freeze')).json();
  expect(freeze.frozen).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  // Overview still served (from rollups) after the raw spans moved to cold.
  const after = await (await ctx.get(`/api/services?from=${from}&to=${now}`)).json();
  expect(after.reduce((a: number, s: any) => a + s.count, 0)).toBe(totalBefore);

  // Raw spans read back by unpacking cold storage.
  const q = await (await ctx.post('/api/query', { data: { sql: 'SELECT count(*) AS c FROM spans' } })).json();
  expect(q.rows[0].c).toBeGreaterThan(0);

  // A single trace's waterfall resolves from cold.
  const traces = await (await ctx.get(`/api/traces?from=${from}&to=${now}&limit=1`)).json();
  expect(traces.length).toBeGreaterThan(0);
  const trace = await (await ctx.get(`/api/trace/${traces[0].trace_id}?day=${now}`)).json();
  expect(trace.spans.length).toBeGreaterThan(0);

  await ctx.dispose();
});

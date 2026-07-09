import { BUCKET_COUNT, emptyHistogram, mergeInto, percentileFromHistogram } from '@mo/shared';
import type { RollupRow } from './store/DuckStore.js';

export function histFrom(buckets: number[], counts: number[]): number[] {
  const h = emptyHistogram();
  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    if (b >= 0 && b < BUCKET_COUNT) h[b] += counts[i] ?? 0;
  }
  return h;
}

export interface Agg {
  n: number;
  errors: number;
  sumDurNs: number;
  hist: number[];
}

export function newAgg(): Agg {
  return { n: 0, errors: 0, sumDurNs: 0, hist: emptyHistogram() };
}

export function addRow(a: Agg, r: RollupRow): void {
  a.n += r.n;
  a.errors += r.errors;
  a.sumDurNs += r.sum_dur_ns;
  mergeInto(a.hist, histFrom(r.buckets, r.counts));
}

export interface Summary {
  count: number;
  errorRate: number;
  throughputPerMin: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export function summarize(a: Agg, windowMs: number): Summary {
  const minutes = Math.max(windowMs / 60_000, 1 / 60);
  return {
    count: a.n,
    errorRate: a.n ? a.errors / a.n : 0,
    throughputPerMin: a.n / minutes,
    avgMs: a.n ? a.sumDurNs / a.n / 1e6 : 0,
    p50Ms: percentileFromHistogram(a.hist, 0.5),
    p95Ms: percentileFromHistogram(a.hist, 0.95),
    p99Ms: percentileFromHistogram(a.hist, 0.99),
  };
}

/** Group rollup rows by a key and summarize each group. */
export function groupSummaries<K extends string>(
  rows: RollupRow[],
  keyOf: (r: RollupRow) => K | null,
  windowMs: number,
): Map<K, Summary & { agg: Agg }> {
  const groups = new Map<K, Agg>();
  for (const r of rows) {
    const k = keyOf(r);
    if (k === null) continue;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = newAgg()));
    addRow(g, r);
  }
  const out = new Map<K, Summary & { agg: Agg }>();
  for (const [k, a] of groups) out.set(k, { ...summarize(a, windowMs), agg: a });
  return out;
}

/** Hourly time series of a metric for charting. */
export function timeseries(rows: RollupRow[], metric: 'throughput' | 'p95' | 'p50' | 'p99' | 'errorRate' | 'avg') {
  const byHour = new Map<number, Agg>();
  for (const r of rows) {
    let a = byHour.get(r.hour_ms);
    if (!a) byHour.set(r.hour_ms, (a = newAgg()));
    addRow(a, r);
  }
  return [...byHour.entries()]
    .sort((x, y) => x[0] - y[0])
    .map(([hour, a]) => {
      const s = summarize(a, 3_600_000);
      const value =
        metric === 'throughput'
          ? s.throughputPerMin
          : metric === 'errorRate'
            ? s.errorRate
            : metric === 'avg'
              ? s.avgMs
              : metric === 'p50'
                ? s.p50Ms
                : metric === 'p99'
                  ? s.p99Ms
                  : s.p95Ms;
      return { t: hour, value };
    });
}

/** Time-in-span-type breakdown (self-time approximation via span_type sums). */
export function breakdown(rows: RollupRow[]) {
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.span_type, (byType.get(r.span_type) ?? 0) + r.sum_dur_ns);
  const total = [...byType.values()].reduce((a, b) => a + b, 0) || 1;
  return [...byType.entries()]
    .map(([type, sum]) => ({ type, ms: sum / 1e6, fraction: sum / total }))
    .sort((a, b) => b.ms - a.ms);
}

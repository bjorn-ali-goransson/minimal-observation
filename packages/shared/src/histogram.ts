/**
 * Fixed-boundary latency histograms. These are what make the freeze-to-S3 model
 * viable: histograms are *mergeable* (sum bucket counts), so a "p95 over 7 days"
 * can be answered from small per-hour rollups without ever touching raw cold spans.
 * Percentiles from a merged histogram are approximate (log-spaced buckets) but
 * plenty accurate for overview screens; exact percentiles come from raw hot data.
 */

// Log-spaced upper bounds in milliseconds, ~0.25ms .. ~120s.
export const BUCKET_BOUNDS_MS: number[] = (() => {
  const bounds: number[] = [];
  let v = 0.25;
  while (v <= 120_000) {
    bounds.push(Math.round(v * 1000) / 1000);
    v *= 1.5;
  }
  bounds.push(Infinity);
  return bounds;
})();

export const BUCKET_COUNT = BUCKET_BOUNDS_MS.length;

export function bucketIndex(durMs: number): number {
  // binary search for first bound >= durMs
  let lo = 0;
  let hi = BUCKET_BOUNDS_MS.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (BUCKET_BOUNDS_MS[mid] < durMs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function emptyHistogram(): number[] {
  return new Array(BUCKET_COUNT).fill(0);
}

export function mergeInto(target: number[], src: number[]): number[] {
  for (let i = 0; i < BUCKET_COUNT; i++) target[i] += src[i] ?? 0;
  return target;
}

/** Approximate quantile (0..1) from a histogram, interpolating within the target bucket. */
export function percentileFromHistogram(hist: number[], q: number): number {
  const total = hist.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < BUCKET_COUNT; i++) {
    const c = hist[i];
    if (c === 0) continue;
    if (cum + c >= rank) {
      const lower = i === 0 ? 0 : BUCKET_BOUNDS_MS[i - 1];
      const upper = BUCKET_BOUNDS_MS[i] === Infinity ? lower * 1.5 : BUCKET_BOUNDS_MS[i];
      const frac = (rank - cum) / c;
      return lower + (upper - lower) * frac;
    }
    cum += c;
  }
  return BUCKET_BOUNDS_MS[BUCKET_COUNT - 2] ?? 0;
}

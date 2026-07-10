const KEY_STORE = 'mo.apikey';

export function getKey(): string {
  return localStorage.getItem(KEY_STORE) || '';
}
export function setKey(k: string): void {
  localStorage.setItem(KEY_STORE, k);
}

export async function api<T = any>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-api-key': getKey(), 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  if (res.status === 401) throw new ApiError('unauthorized', 401);
  if (!res.ok) throw new ApiError((await res.text()) || res.statusText, res.status);
  const cold = res.headers.get('X-MO-Cold');
  if (cold) notifyCold(cold.split(',').filter(Boolean));
  const ct = res.headers.get('content-type') || '';
  return (ct.includes('json') ? await res.json() : await res.text()) as T;
}

// Pub/sub for "this response drew on frozen (cold/S3) storage" — used by the cold indicator.
type ColdListener = (days: string[]) => void;
const coldListeners = new Set<ColdListener>();
export function onCold(fn: ColdListener): () => void {
  coldListeners.add(fn);
  return () => coldListeners.delete(fn);
}
function notifyCold(days: string[]) {
  coldListeners.forEach((f) => f(days));
}

export class ApiError extends Error {
  constructor(
    msg: string,
    public status: number,
  ) {
    super(msg);
  }
}

export function withRange(path: string, r: { fromMs: number; toMs: number }, extra: Record<string, string | number | undefined> = {}) {
  const u = new URLSearchParams({ from: String(Math.floor(r.fromMs)), to: String(Math.floor(r.toMs)) });
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '') u.set(k, String(v));
  return `${path}?${u.toString()}`;
}

// ---- shared range state ----
export const RANGES: { label: string; ms: number }[] = [
  { label: '15m', ms: 15 * 60_000 },
  { label: '1h', ms: 3_600_000 },
  { label: '6h', ms: 6 * 3_600_000 },
  { label: '24h', ms: 24 * 3_600_000 },
  { label: '7d', ms: 7 * 24 * 3_600_000 },
];

export function currentRange(): { fromMs: number; toMs: number; label: string } {
  const label = localStorage.getItem('mo.range') || '1h';
  const ms = (RANGES.find((r) => r.label === label) || RANGES[1]).ms;
  const toMs = Date.now();
  return { fromMs: toMs - ms, toMs, label };
}
export function setRange(label: string) {
  localStorage.setItem('mo.range', label);
}

export const ms = (v: number | undefined | null): string => {
  if (v === undefined || v === null || Number.isNaN(v)) return '–';
  if (v < 1) return `${(v * 1000).toFixed(0)}µs`;
  if (v < 1000) return `${v.toFixed(v < 10 ? 1 : 0)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
};
export const pct = (v: number | undefined | null): string => (v === undefined || v === null ? '–' : `${(v * 100).toFixed(2)}%`);
export const num = (v: number | undefined | null): string => (v === undefined || v === null ? '–' : v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v.toFixed(v < 10 && v % 1 !== 0 ? 1 : 0));
export const rate = (v: number | undefined | null): string => (v === undefined || v === null ? '–' : `${v < 1 ? v.toFixed(2) : v.toFixed(1)}/min`);
export const time = (msEpoch: number): string => new Date(msEpoch).toLocaleTimeString();
export const errColor = (r: number) => (r > 0.05 ? 'var(--err)' : r > 0.01 ? 'var(--warn)' : 'var(--ok)');
export const TYPE_COLORS: Record<string, string> = {
  http: '#6ea8fe',
  external: '#c792ea',
  db: '#7ee787',
  messaging: '#f0a868',
  fs: '#79c0ff',
  internal: '#8b949e',
};

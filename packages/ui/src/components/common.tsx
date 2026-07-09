import { useEffect, useState } from 'react';
import { ApiError } from '../api.js';

export function useData<T>(fn: () => Promise<T>, deps: any[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [n, setN] = useState(0);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    fn()
      .then((d) => alive && (setData(d), setError(null)))
      .catch((e: ApiError) => alive && setError(e.message || String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { data, error, loading, reload: () => setN((x) => x + 1) };
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <div className="panel err">Error: {error}</div>;
  return <div className="spinner">Loading…</div>;
}

export function Stat({ k, v, color }: { k: string; v: React.ReactNode; color?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v" style={color ? { color } : undefined}>
        {v}
      </div>
    </div>
  );
}

export function Bar({ frac, color }: { frac: number; color: string }) {
  return (
    <div className="bar">
      <i style={{ width: `${Math.min(100, frac * 100)}%`, background: color }} />
    </div>
  );
}

export function StatusPill({ status }: { status: string }) {
  const c = status === 'ERROR' ? 'var(--err)' : status === 'OK' ? 'var(--ok)' : 'var(--muted)';
  return <span className="pill" style={{ background: 'transparent', color: c, border: `1px solid ${c}` }}>{status}</span>;
}

export function useSort<T>(rows: T[], initial: keyof T): [T[], (k: keyof T) => void, keyof T] {
  const [key, setKey] = useState<keyof T>(initial);
  const [dir, setDir] = useState(-1);
  const sorted = [...rows].sort((a, b) => {
    const av = a[key] as any;
    const bv = b[key] as any;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  const onSort = (k: keyof T) => {
    if (k === key) setDir((d) => -d);
    else {
      setKey(k);
      setDir(-1);
    }
  };
  return [sorted, onSort, key];
}

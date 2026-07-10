import { useEffect, useState } from 'react';
import { api, onCold } from '../api.js';

interface FrozenDay {
  day: string;
  loaded: boolean;
  loadingNow: boolean;
}
interface FrozenStatus {
  coldKind: string;
  idleMs: number;
  loadingNow: boolean;
  days: FrozenDay[];
}

// Shows cold-tier (frozen/S3) state: how many days are frozen, which are loaded, when a fetch is
// in flight, and a transient "served from cold" flash when a request just read frozen data.
export function ColdBadge() {
  const [st, setSt] = useState<FrozenStatus | null>(null);
  const [flash, setFlash] = useState<string[] | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = () => api<FrozenStatus>('/api/frozen').then((s) => alive && setSt(s)).catch(() => {});
    poll();
    const id = setInterval(poll, 4000);
    const off = onCold((days) => {
      setFlash(days);
      poll();
      setTimeout(() => alive && setFlash(null), 4000);
    });
    return () => {
      alive = false;
      clearInterval(id);
      off();
    };
  }, []);

  if (!st || (st.days.length === 0 && st.coldKind !== 's3')) return null;
  const loaded = st.days.filter((d) => d.loaded);
  const idleMin = Math.round(st.idleMs / 60000);

  let label: string;
  let color = 'var(--muted)';
  if (st.loadingNow || (flash && loaded.length === 0)) {
    label = `⛁ loading from ${st.coldKind === 's3' ? 'S3' : 'cold'}…`;
    color = 'var(--accent)';
  } else if (flash) {
    label = `⛁ served from cold: ${flash.join(', ')}`;
    color = 'var(--accent)';
  } else if (loaded.length) {
    label = `⛁ ${loaded.length} loaded from cold`;
    color = 'var(--ok)';
  } else {
    label = `⛁ cold: ${st.days.length} day${st.days.length === 1 ? '' : 's'}`;
  }

  const title =
    `Cold tier: ${st.coldKind}\n` +
    `${st.days.length} frozen day(s); ${loaded.length} loaded\n` +
    (loaded.length ? `loaded: ${loaded.map((d) => d.day).join(', ')}\n` : '') +
    `auto-unloads after ${idleMin}m idle`;

  return (
    <span
      className="tag"
      title={title}
      style={{ color, borderColor: color, border: `1px solid ${color}`, whiteSpace: 'nowrap', transition: 'color .3s' }}
    >
      {label}
    </span>
  );
}

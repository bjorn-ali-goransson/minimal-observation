import { useEffect, useState } from 'react';

export function useHashRoute(): [string[], (to: string) => void] {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/services');
  useEffect(() => {
    const on = () => setHash(window.location.hash.slice(1) || '/services');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const nav = (to: string) => {
    window.location.hash = to;
  };
  const parts = hash.split('?')[0].split('/').filter(Boolean);
  return [parts, nav];
}

export function query(): URLSearchParams {
  const q = window.location.hash.split('?')[1] || '';
  return new URLSearchParams(q);
}

export function link(path: string, params: Record<string, string> = {}): string {
  const q = new URLSearchParams(params).toString();
  return `#${path}${q ? '?' + q : ''}`;
}

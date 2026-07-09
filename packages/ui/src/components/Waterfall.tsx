import { useState } from 'react';
import { ms } from '../format.js';
import { TYPE_COLORS } from '../format.js';

export interface WSpan {
  span_id: string;
  parent_id: string | null;
  service: string;
  name: string;
  span_type: string;
  status: string;
  start_ms: number;
  dur_ms: number;
  db_statement?: string | null;
  db_rows?: number;
  http_status?: number | null;
  dependency?: string | null;
  attrs?: Record<string, unknown>;
}

export function Waterfall({ spans }: { spans: WSpan[] }) {
  const [sel, setSel] = useState<WSpan | null>(null);
  if (!spans.length) return <div className="spinner">trace not found (it may have aged out of retention)</div>;

  const t0 = Math.min(...spans.map((s) => s.start_ms));
  const t1 = Math.max(...spans.map((s) => s.start_ms + s.dur_ms));
  const total = Math.max(t1 - t0, 0.001);

  // order spans as a tree (DFS by parent)
  const byParent = new Map<string | null, WSpan[]>();
  for (const s of spans) {
    const k = s.parent_id && spans.some((x) => x.span_id === s.parent_id) ? s.parent_id : null;
    (byParent.get(k) ?? byParent.set(k, []).get(k)!).push(s);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.start_ms - b.start_ms);
  const ordered: { s: WSpan; depth: number }[] = [];
  const walk = (pid: string | null, depth: number) => {
    for (const s of byParent.get(pid) ?? []) {
      ordered.push({ s, depth });
      walk(s.span_id, depth + 1);
    }
  };
  walk(null, 0);

  return (
    <div>
      <div className="muted" style={{ marginBottom: 8 }}>
        {spans.length} spans · {ms(total)} total
      </div>
      {ordered.map(({ s, depth }) => {
        const left = ((s.start_ms - t0) / total) * 100;
        const width = (s.dur_ms / total) * 100;
        const color = s.status === 'ERROR' ? 'var(--err)' : TYPE_COLORS[s.span_type] || '#8b949e';
        return (
          <div className="wf-row" key={s.span_id} onClick={() => setSel(s)} style={{ cursor: 'pointer' }}>
            <div className="wf-label" style={{ paddingLeft: depth * 14 }} title={`${s.service} · ${s.name}`}>
              <span className="tag" style={{ color }}>
                {s.span_type}
              </span>{' '}
              {s.name}
            </div>
            <div className="wf-track">
              <div className="wf-bar" style={{ left: `${left}%`, width: `${Math.max(width, 0.4)}%`, background: color }} />
            </div>
            <div className="mono" style={{ width: 70, textAlign: 'right' }}>
              {ms(s.dur_ms)}
            </div>
          </div>
        );
      })}
      {sel && (
        <div className="panel" style={{ marginTop: 14 }}>
          <h3>{sel.name}</h3>
          <table>
            <tbody>
              <Row k="service" v={sel.service} />
              <Row k="type" v={sel.span_type} />
              <Row k="duration" v={ms(sel.dur_ms)} />
              <Row k="status" v={sel.status} />
              {sel.dependency && <Row k="dependency" v={sel.dependency} />}
              {sel.http_status != null && <Row k="http.status" v={String(sel.http_status)} />}
              {sel.db_statement && <Row k="db.statement" v={<span className="mono">{sel.db_statement}</span>} />}
              {sel.db_rows !== undefined && sel.db_rows >= 0 && <Row k="db.rows" v={String(sel.db_rows)} />}
              {sel.attrs &&
                Object.entries(sel.attrs)
                  .filter(([k]) => !['db.statement'].includes(k))
                  .map(([k, v]) => <Row key={k} k={k} v={<span className="mono">{String(v)}</span>} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <tr>
      <td className="muted" style={{ width: 160 }}>
        {k}
      </td>
      <td>{v}</td>
    </tr>
  );
}

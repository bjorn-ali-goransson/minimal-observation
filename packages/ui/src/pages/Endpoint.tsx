import { useState } from 'react';
import { api, withRange, currentRange, getKey } from '../api.js';
import { useData, Loading, Stat, Bar } from '../components/common.js';
import { Chart } from '../components/Chart.js';
import { ms, pct, num, rate, errColor, TYPE_COLORS } from '../format.js';
import { link, query } from '../router.js';

type Pt = { t: number; value: number };
interface Detail {
  summary: { n: number; errors: number; p50: number; p95: number; p99: number; avg: number; max: number };
  throughputPerMin: number;
  series: { throughput: Pt[]; p50: Pt[]; p95: Pt[]; p99: Pt[]; errorRate: Pt[] };
  breakdown: { type: string; ms: number; fraction: number }[];
}
interface Trace {
  trace_id: string;
  name: string;
  service: string;
  status: string;
  start_ms: number;
  dur_ms: number;
}

function align(seriesList: Pt[][]): { x: number[]; ys: number[][] } {
  const xs = [...new Set(seriesList.flatMap((s) => s.map((p) => p.t)))].sort((a, b) => a - b);
  const ys = seriesList.map((s) => {
    const m = new Map(s.map((p) => [p.t, p.value]));
    return xs.map((t) => m.get(t) ?? null) as unknown as number[];
  });
  return { x: xs.map((t) => t / 1000), ys };
}

export function Endpoint({ range }: { range: ReturnType<typeof currentRange> }) {
  const service = query().get('service') || '';
  const name = query().get('name') || '';
  const [minDur, setMinDur] = useState('');
  const { data, error, loading } = useData<Detail>(() => api(withRange('/api/endpoint', range, { service, name })), [service, name, range.fromMs, range.label]);
  const traces = useData<Trace[]>(() => api(withRange('/api/traces', range, { service, name, minDur, limit: 100 })), [service, name, range.fromMs, range.label, minDur]);

  if (loading || error || !data) return <Loading error={error} />;
  const s = data.summary || ({} as Detail['summary']);
  const lat = align([data.series.p50, data.series.p95, data.series.p99]);
  const tp = align([data.series.throughput, data.series.errorRate]);
  const exportUrl = `/api/export?${new URLSearchParams({ from: String(Math.floor(range.fromMs)), to: String(Math.floor(range.toMs)), service, name, format: 'csv' })}`;

  return (
    <div className="content">
      <div className="crumbs">
        <a href={link('/services')}>Services</a> / <a href={link('/service', { service })}>{service}</a> / {name}
      </div>
      <div className="h1 mono">{name}</div>
      <div className="crumbs">last {range.label}</div>

      <div className="grid cards" style={{ marginBottom: 16 }}>
        <Stat k="Requests" v={num(s.n)} />
        <Stat k="Throughput" v={rate(data.throughputPerMin)} />
        <Stat k="Error rate" v={pct((s.errors || 0) / (s.n || 1))} color={errColor((s.errors || 0) / (s.n || 1))} />
        <Stat k="p50" v={ms(s.p50)} />
        <Stat k="p95" v={ms(s.p95)} />
        <Stat k="p99" v={ms(s.p99)} />
        <Stat k="max" v={ms(s.max)} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="panel">
          <h3>Latency percentiles</h3>
          <Chart x={lat.x} yFmt={ms} series={[{ label: 'p50', color: '#6ea8fe', data: lat.ys[0] }, { label: 'p95', color: '#d29922', data: lat.ys[1] }, { label: 'p99', color: '#f85149', data: lat.ys[2] }]} />
        </div>
        <div className="panel">
          <h3>Throughput & error rate</h3>
          <Chart x={tp.x} series={[{ label: 'req/min', color: '#3fb950', data: tp.ys[0] }, { label: 'error rate', color: '#f85149', data: tp.ys[1].map((v) => (v == null ? v : v * 100)) }]} />
        </div>
      </div>

      <div className="panel">
        <h3>Performance breakdown (time by span type)</h3>
        {data.breakdown.map((b) => (
          <div key={b.type} style={{ marginBottom: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
              <span>
                <span className="tag" style={{ color: TYPE_COLORS[b.type] }}>{b.type}</span>
              </span>
              <span className="mono muted">
                {ms(b.ms)} · {pct(b.fraction)}
              </span>
            </div>
            <Bar frac={b.fraction} color={TYPE_COLORS[b.type] || '#8b949e'} />
          </div>
        ))}
        {!data.breakdown.length && <span className="muted">no child spans sampled</span>}
      </div>

      <div className="panel">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <h3 style={{ margin: 0 }}>Requests</h3>
          <span className="spacer" style={{ flex: 1 }} />
          <input placeholder="min dur ms" value={minDur} onChange={(e) => setMinDur(e.target.value)} style={{ width: 100 }} />
          <a href={exportUrl + '&k=' + encodeURIComponent(getKey())} download="spans.csv">
            <button>Export CSV</button>
          </a>
        </div>
        <table>
          <thead>
            <tr>
              <th>Trace</th>
              <th>Service</th>
              <th>Status</th>
              <th>Time</th>
              <th className="num">Duration</th>
            </tr>
          </thead>
          <tbody>
            {(traces.data || []).map((t) => (
              <tr key={t.trace_id}>
                <td className="mono">
                  <a href={link('/trace', { traceId: t.trace_id, day: String(t.start_ms) })}>{t.trace_id.slice(0, 12)}…</a>
                </td>
                <td>{t.service}</td>
                <td style={{ color: t.status === 'ERROR' ? 'var(--err)' : 'var(--ok)' }}>{t.status}</td>
                <td className="muted">{new Date(t.start_ms).toLocaleTimeString()}</td>
                <td className="num">{ms(t.dur_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

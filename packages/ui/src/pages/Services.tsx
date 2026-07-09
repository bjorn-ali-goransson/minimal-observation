import { api, withRange, currentRange } from '../api.js';
import { useData, Loading, useSort } from '../components/common.js';
import { ms, pct, rate, num, errColor } from '../format.js';
import { link } from '../router.js';

interface Svc {
  service: string;
  count: number;
  errorRate: number;
  throughputPerMin: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export function Services({ range }: { range: ReturnType<typeof currentRange> }) {
  const { data, error, loading } = useData<Svc[]>(() => api(withRange('/api/services', range)), [range.fromMs, range.label]);
  const [rows, onSort, key] = useSort<Svc>(data || [], 'count');
  if (loading || error) return <Loading error={error} />;

  return (
    <div className="content">
      <div className="h1">Services</div>
      <div className="crumbs">{rows.length} services · last {range.label}</div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              {(['service', 'throughputPerMin', 'p50Ms', 'p95Ms', 'p99Ms', 'errorRate', 'count'] as (keyof Svc)[]).map((c) => (
                <th key={c} className={c === 'service' ? '' : 'num'} onClick={() => onSort(c)}>
                  {LABEL[c]} {key === c ? '▾' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.service}>
                <td>
                  <a href={link('/service', { service: s.service })}>{s.service}</a>
                </td>
                <td className="num">{rate(s.throughputPerMin)}</td>
                <td className="num">{ms(s.p50Ms)}</td>
                <td className="num">{ms(s.p95Ms)}</td>
                <td className="num">{ms(s.p99Ms)}</td>
                <td className="num" style={{ color: errColor(s.errorRate) }}>{pct(s.errorRate)}</td>
                <td className="num">{num(s.count)}</td>
              </tr>
            ))}
            {!rows.length && (
              <tr>
                <td colSpan={7} className="muted">
                  No data in range. Run <code className="mono">pnpm seed</code> or send OTLP traces.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LABEL: Record<string, string> = {
  service: 'Service',
  throughputPerMin: 'Throughput',
  p50Ms: 'p50',
  p95Ms: 'p95',
  p99Ms: 'p99',
  errorRate: 'Error rate',
  count: 'Requests',
};

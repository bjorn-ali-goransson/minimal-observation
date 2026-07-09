import { api, withRange, currentRange } from '../api.js';
import { useData, Loading, useSort } from '../components/common.js';
import { ms, pct, rate, num, errColor } from '../format.js';
import { link, query } from '../router.js';

interface Ep {
  name: string;
  count: number;
  errorRate: number;
  throughputPerMin: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

export function Service({ range }: { range: ReturnType<typeof currentRange> }) {
  const service = query().get('service') || '';
  const { data, error, loading } = useData<Ep[]>(() => api(withRange(`/api/services/${encodeURIComponent(service)}/endpoints`, range)), [service, range.fromMs, range.label]);
  const [rows, onSort, key] = useSort<Ep>(data || [], 'count');
  if (loading || error) return <Loading error={error} />;

  return (
    <div className="content">
      <div className="crumbs">
        <a href={link('/services')}>Services</a> / {service}
      </div>
      <div className="h1">{service}</div>
      <div className="crumbs">{rows.length} endpoints · last {range.label}</div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th onClick={() => onSort('name')}>Endpoint</th>
              {(['throughputPerMin', 'p50Ms', 'p95Ms', 'p99Ms', 'errorRate', 'count'] as (keyof Ep)[]).map((c) => (
                <th key={c} className="num" onClick={() => onSort(c)}>
                  {LABEL[c]} {key === c ? '▾' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.name}>
                <td className="mono">
                  <a href={link('/endpoint', { service, name: e.name })}>{e.name}</a>
                </td>
                <td className="num">{rate(e.throughputPerMin)}</td>
                <td className="num">{ms(e.p50Ms)}</td>
                <td className="num">{ms(e.p95Ms)}</td>
                <td className="num">{ms(e.p99Ms)}</td>
                <td className="num" style={{ color: errColor(e.errorRate) }}>{pct(e.errorRate)}</td>
                <td className="num">{num(e.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LABEL: Record<string, string> = { throughputPerMin: 'Throughput', p50Ms: 'p50', p95Ms: 'p95', p99Ms: 'p99', errorRate: 'Error rate', count: 'Requests' };

import { api, withRange, currentRange } from '../api.js';
import { useData, Loading, useSort } from '../components/common.js';
import { ms, pct, rate, num, errColor, TYPE_COLORS } from '../format.js';
import { link } from '../router.js';

interface Dep {
  dependency: string;
  span_type: string;
  count: number;
  errorRate: number;
  throughputPerMin: number;
  p95Ms: number;
  p99Ms: number;
}

export function Dependencies({ range }: { range: ReturnType<typeof currentRange> }) {
  const { data, error, loading } = useData<Dep[]>(() => api(withRange('/api/dependencies', range)), [range.fromMs, range.label]);
  const [rows, onSort, key] = useSort<Dep>(data || [], 'count');
  if (loading || error) return <Loading error={error} />;

  return (
    <div className="content">
      <div className="h1">Dependencies</div>
      <div className="crumbs">{rows.length} dependencies · last {range.label}</div>
      <div className="panel">
        <table>
          <thead>
            <tr>
              <th onClick={() => onSort('dependency')}>Dependency</th>
              <th>Type</th>
              {(['throughputPerMin', 'p95Ms', 'p99Ms', 'errorRate', 'count'] as (keyof Dep)[]).map((c) => (
                <th key={c} className="num" onClick={() => onSort(c)}>
                  {LABEL[c]} {key === c ? '▾' : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.dependency + d.span_type}>
                <td className="mono">
                  <a href={link('/dependency', { dependency: d.dependency })}>{d.dependency}</a>
                </td>
                <td>
                  <span className="tag" style={{ color: TYPE_COLORS[d.span_type] }}>{d.span_type}</span>
                </td>
                <td className="num">{rate(d.throughputPerMin)}</td>
                <td className="num">{ms(d.p95Ms)}</td>
                <td className="num">{ms(d.p99Ms)}</td>
                <td className="num" style={{ color: errColor(d.errorRate) }}>{pct(d.errorRate)}</td>
                <td className="num">{num(d.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const LABEL: Record<string, string> = { throughputPerMin: 'Throughput', p95Ms: 'p95', p99Ms: 'p99', errorRate: 'Error rate', count: 'Calls' };

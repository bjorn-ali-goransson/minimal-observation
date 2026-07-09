import { api, withRange, currentRange } from '../api.js';
import { useData, Loading, Stat } from '../components/common.js';
import { ms, pct, num, rate } from '../format.js';
import { link, query } from '../router.js';

interface DepDetail {
  dependency: string;
  summary: { count: number; errorRate: number; p50Ms: number; p95Ms: number; p99Ms: number; throughputPerMin: number };
  byService: { service: string; count: number; p95Ms: number; errorRate: number }[];
  endpoints: { service: string; name: string; n: number; avg_ms: number }[];
  recent: { trace_id: string; service: string; name: string; status: string; db_statement?: string; db_rows?: number; start_ms: number; dur_ms: number }[];
}

export function Dependency({ range }: { range: ReturnType<typeof currentRange> }) {
  const dependency = query().get('dependency') || '';
  const { data, error, loading } = useData<DepDetail>(() => api(withRange('/api/dependency', range, { dependency })), [dependency, range.fromMs, range.label]);
  if (loading || error || !data) return <Loading error={error} />;
  const s = data.summary;

  return (
    <div className="content">
      <div className="crumbs">
        <a href={link('/dependencies')}>Dependencies</a> / {dependency}
      </div>
      <div className="h1 mono">{dependency}</div>

      <div className="grid cards" style={{ marginBottom: 16 }}>
        <Stat k="Calls" v={num(s.count)} />
        <Stat k="Throughput" v={rate(s.throughputPerMin)} />
        <Stat k="p50" v={ms(s.p50Ms)} />
        <Stat k="p95" v={ms(s.p95Ms)} />
        <Stat k="p99" v={ms(s.p99Ms)} />
        <Stat k="Error rate" v={pct(s.errorRate)} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="panel">
          <h3>Top calling services</h3>
          <table>
            <thead>
              <tr>
                <th>Service</th>
                <th className="num">Calls</th>
                <th className="num">p95</th>
              </tr>
            </thead>
            <tbody>
              {data.byService.map((b) => (
                <tr key={b.service}>
                  <td>
                    <a href={link('/service', { service: b.service })}>{b.service}</a>
                  </td>
                  <td className="num">{num(b.count)}</td>
                  <td className="num">{ms(b.p95Ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel">
          <h3>Top calling endpoints</h3>
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th className="num">Calls</th>
                <th className="num">avg</th>
              </tr>
            </thead>
            <tbody>
              {data.endpoints.map((e) => (
                <tr key={e.service + e.name}>
                  <td className="mono">
                    <a href={link('/endpoint', { service: e.service, name: e.name })}>{e.name}</a>
                  </td>
                  <td className="num">{num(e.n)}</td>
                  <td className="num">{ms(e.avg_ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <h3>Recent calls</h3>
        <table>
          <thead>
            <tr>
              <th>Trace</th>
              <th>Statement / name</th>
              <th className="num">Rows</th>
              <th className="num">Duration</th>
            </tr>
          </thead>
          <tbody>
            {data.recent.map((r) => (
              <tr key={r.trace_id + r.start_ms}>
                <td className="mono">
                  <a href={link('/trace', { traceId: r.trace_id, day: String(r.start_ms) })}>{r.trace_id.slice(0, 10)}…</a>
                </td>
                <td className="mono" style={{ maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.db_statement || r.name}</td>
                <td className="num">{r.db_rows != null && r.db_rows >= 0 ? r.db_rows : '–'}</td>
                <td className="num">{ms(r.dur_ms)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

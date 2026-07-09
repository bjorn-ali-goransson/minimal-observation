import { api } from '../api.js';
import { useData, Loading } from '../components/common.js';
import { Waterfall, type WSpan } from '../components/Waterfall.js';
import { query, link } from '../router.js';
import { getKey } from '../api.js';

export function Trace() {
  const traceId = query().get('traceId') || '';
  const day = query().get('day') || '';
  const { data, error, loading } = useData<{ spans: WSpan[] }>(() => api(`/api/trace/${traceId}${day ? `?day=${day}` : ''}`), [traceId]);
  if (loading || error) return <Loading error={error} />;
  const exportUrl = `/api/export?${new URLSearchParams({ from: '0', to: String(Date.now()), limit: '2000', k: getKey() })}`;

  return (
    <div className="content">
      <div className="crumbs">
        <a href={link('/services')}>Services</a> / trace
      </div>
      <div className="h1 mono">{traceId.slice(0, 20)}…</div>
      <div className="panel">
        <Waterfall spans={data?.spans || []} />
      </div>
      <a href={exportUrl} download={`trace-${traceId.slice(0, 8)}.json`} className="muted">
        Export spans (JSON) for AI
      </a>
    </div>
  );
}

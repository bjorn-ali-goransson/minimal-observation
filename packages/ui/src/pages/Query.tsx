import { useState } from 'react';
import { api } from '../api.js';
import { Chart } from '../components/Chart.js';

const SAMPLES: Record<string, string> = {
  'Slowest DB statements': `SELECT db_statement, count(*) AS calls, round(avg(dur_ns)/1e6,1) AS avg_ms,\n       round(quantile_cont(dur_ns,0.95)/1e6,1) AS p95_ms, sum(db_rows) AS total_rows\nFROM spans WHERE span_type = 'db'\nGROUP BY 1 ORDER BY p95_ms DESC`,
  'Requests per hour': `SELECT (start_ns // 3600000000000) * 3600 AS t, count(*) AS requests\nFROM spans WHERE is_transaction GROUP BY 1 ORDER BY 1`,
  'Error rate by service': `SELECT service, round(100.0*sum(status='ERROR')/count(*),2) AS error_pct, count(*) AS n\nFROM spans WHERE is_transaction GROUP BY 1 ORDER BY error_pct DESC`,
  'Rows returned distribution': `SELECT db_rows, count(*) AS n FROM spans\nWHERE span_type='db' AND db_rows >= 0 GROUP BY 1 ORDER BY 1`,
};

export function Query() {
  const [sql, setSql] = useState(SAMPLES['Slowest DB statements']);
  const [res, setRes] = useState<{ columns: string[]; rows: any[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    setErr(null);
    try {
      setRes(await api('/api/query', { method: 'POST', body: JSON.stringify({ sql }) }));
    } catch (e: any) {
      setErr(e.message || String(e));
      setRes(null);
    } finally {
      setBusy(false);
    }
  };

  const numericCols = res ? res.columns.filter((c) => res.rows.length && typeof res.rows[0][c] === 'number') : [];
  const xCol = res?.columns[0];
  const canChart = res && numericCols.length >= 1 && res.rows.length > 1;
  const x = canChart ? res!.rows.map((r, i) => (typeof r[xCol!] === 'number' ? r[xCol!] : i)) : [];
  const palette = ['#6ea8fe', '#3fb950', '#d29922', '#f85149', '#c792ea'];

  return (
    <div className="content">
      <div className="h1">Query</div>
      <div className="crumbs">Read-only DuckDB SQL over a <code className="mono">spans</code> relation spanning the retention window.</div>
      <div className="panel">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {Object.keys(SAMPLES).map((k) => (
            <button key={k} onClick={() => setSql(SAMPLES[k])}>
              {k}
            </button>
          ))}
        </div>
        <textarea rows={7} value={sql} onChange={(e) => setSql(e.target.value)} />
        <div style={{ marginTop: 10 }}>
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? 'Running…' : 'Run'}
          </button>
        </div>
      </div>

      {err && <div className="panel err">{err}</div>}

      {canChart && (
        <div className="panel">
          <h3>Chart</h3>
          <Chart
            x={typeof res!.rows[0][xCol!] === 'number' ? x : res!.rows.map((_, i) => i)}
            series={numericCols.filter((c) => c !== xCol).map((c, i) => ({ label: c, color: palette[i % palette.length], data: res!.rows.map((r) => r[c]) }))}
          />
        </div>
      )}

      {res && (
        <div className="panel" style={{ overflowX: 'auto' }}>
          <h3>{res.rows.length} rows</h3>
          <table>
            <thead>
              <tr>{res.columns.map((c) => <th key={c}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {res.rows.slice(0, 500).map((r, i) => (
                <tr key={i}>
                  {res.columns.map((c) => (
                    <td key={c} className={typeof r[c] === 'number' ? 'num mono' : 'mono'}>
                      {r[c] === null ? '–' : String(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

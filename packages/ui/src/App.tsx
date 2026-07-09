import { useEffect, useState } from 'react';
import { api, getKey, setKey, currentRange, setRange, RANGES } from './api.js';
import { useHashRoute, link } from './router.js';
import { Services } from './pages/Services.js';
import { Service } from './pages/Service.js';
import { Endpoint } from './pages/Endpoint.js';
import { Trace } from './pages/Trace.js';
import { Dependencies } from './pages/Dependencies.js';
import { Dependency } from './pages/Dependency.js';
import { Query } from './pages/Query.js';
import { Agent } from './pages/Agent.js';

interface Meta {
  currentDay: string;
  retentionDays: number;
  coldKind: string;
  agentEnabled: boolean;
}

export function App() {
  const [parts, nav] = useHashRoute();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [rangeLabel, setRangeLabel] = useState(currentRange().label);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!getKey()) {
      setAuthed(false);
      return;
    }
    api<Meta>('/api/meta')
      .then((m) => {
        setMeta(m);
        setAuthed(true);
      })
      .catch(() => setAuthed(false));
  }, [tick]);

  if (authed === false) return <KeyGate onSaved={() => setTick((t) => t + 1)} />;
  if (authed === null) return <div className="spinner">Connecting…</div>;

  const range = currentRange();
  const page = parts[0] || 'services';
  const routeKey = window.location.hash + '#' + tick; // force remount on nav/refresh

  return (
    <div className="app">
      <div className="sidebar">
        <div className="brand">
          Minimal Observation
          <small>feather-light APM</small>
        </div>
        <div className="nav">
          <a className={page === 'services' || page === 'service' || page === 'endpoint' || page === 'trace' ? 'active' : ''} href={link('/services')}>
            Services
          </a>
          <a className={page.startsWith('depend') ? 'active' : ''} href={link('/dependencies')}>
            Dependencies
          </a>
          <a className={page === 'query' ? 'active' : ''} href={link('/query')}>
            Query
          </a>
          <a className={page === 'agent' ? 'active' : ''} href={link('/agent')}>
            AI Investigator
          </a>
        </div>
        {meta && (
          <div className="muted" style={{ position: 'absolute', bottom: 12, fontSize: 11, lineHeight: 1.7 }}>
            retention {meta.retentionDays}d · cold: {meta.coldKind}
            <br />
            today {meta.currentDay}
            <br />
            agent {meta.agentEnabled ? 'on' : 'off'}
          </div>
        )}
      </div>
      <div className="main">
        <div className="topbar">
          <div className="seg">
            {RANGES.map((r) => (
              <button
                key={r.label}
                className={rangeLabel === r.label ? 'on' : ''}
                onClick={() => {
                  setRange(r.label);
                  setRangeLabel(r.label);
                  setTick((t) => t + 1);
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
          <button onClick={() => setTick((t) => t + 1)}>↻ Refresh</button>
          <div className="spacer" />
          <button
            onClick={() => {
              setKey('');
              setAuthed(false);
            }}
          >
            Sign out
          </button>
        </div>
        <div key={routeKey}>
          {page === 'services' && <Services range={range} />}
          {page === 'service' && <Service range={range} />}
          {page === 'endpoint' && <Endpoint range={range} />}
          {page === 'trace' && <Trace />}
          {page === 'dependencies' && <Dependencies range={range} />}
          {page === 'dependency' && <Dependency range={range} />}
          {page === 'query' && <Query />}
          {page === 'agent' && <Agent enabled={!!meta?.agentEnabled} />}
        </div>
      </div>
    </div>
  );
}

function KeyGate({ onSaved }: { onSaved: () => void }) {
  const [val, setVal] = useState(getKey());
  return (
    <div className="keygate panel">
      <div className="h1">Minimal Observation</div>
      <p className="muted">Enter your API key to continue. (Default dev key: <code className="mono">dev-secret-key</code>)</p>
      <input style={{ width: '100%', marginBottom: 10 }} value={val} onChange={(e) => setVal(e.target.value)} placeholder="API key" />
      <button
        className="primary"
        onClick={() => {
          setKey(val.trim());
          onSaved();
        }}
      >
        Connect
      </button>
    </div>
  );
}

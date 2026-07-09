import { useState } from 'react';
import { api } from '../api.js';

const PROMPTS = [
  'Investigate the performance issue: which endpoint has the worst p99 and why?',
  'Find the slowest traces and compare them to fast ones — what differs?',
  'Which dependency contributes most to latency, and which endpoints call it?',
  'Where are errors concentrated and what do they have in common?',
];

interface Step {
  tool: string;
  input: unknown;
  resultPreview: string;
}

export function Agent({ enabled }: { enabled: boolean }) {
  const [q, setQ] = useState(PROMPTS[0]);
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState('');
  const [steps, setSteps] = useState<Step[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setErr(null);
    setAnswer('');
    setSteps([]);
    try {
      const r = await api<{ answer: string; steps: Step[] }>('/api/agent', { method: 'POST', body: JSON.stringify({ question: q }) });
      setAnswer(r.answer);
      setSteps(r.steps);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content">
      <div className="h1">AI Investigator</div>
      <div className="crumbs">An agent that pivots across traces, dependencies and cohorts to find root causes.</div>
      {!enabled && <div className="panel err">Agent disabled — set <code className="mono">ANTHROPIC_API_KEY</code> on the server to enable.</div>}
      <div className="panel">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
          {PROMPTS.map((p) => (
            <button key={p} onClick={() => setQ(p)} style={{ fontSize: 11 }}>
              {p.slice(0, 42)}…
            </button>
          ))}
        </div>
        <textarea rows={3} value={q} onChange={(e) => setQ(e.target.value)} />
        <div style={{ marginTop: 10 }}>
          <button className="primary" onClick={run} disabled={busy || !enabled}>
            {busy ? 'Investigating…' : 'Investigate'}
          </button>
        </div>
      </div>

      {err && <div className="panel err">{err}</div>}
      {answer && (
        <div className="panel">
          <h3>Analysis</h3>
          <pre className="answer">{answer}</pre>
        </div>
      )}
      {steps.length > 0 && (
        <div className="panel">
          <h3>Investigation trail ({steps.length} steps)</h3>
          <div className="steps">
            {steps.map((s, i) => (
              <div className="step" key={i}>
                <div className="t">
                  {s.tool}({JSON.stringify(s.input)})
                </div>
                <div className="muted mono" style={{ fontSize: 11 }}>
                  {s.resultPreview}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

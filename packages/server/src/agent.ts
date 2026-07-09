import Anthropic from '@anthropic-ai/sdk';
import type { FastifyInstance } from 'fastify';
import type { DuckStore } from './store/DuckStore.js';
import { config } from './config.js';
import { requireApiKey } from './auth.js';

/**
 * The "Investigate performance issue" agent. It is deliberately given the same
 * primitives the UI uses, so it can *pivot*: from one slow trace to similar
 * traces, to the same dependency across services, to fast-vs-slow cohorts —
 * each pivot is one tool call = one query against the tiered store.
 */

const SYSTEM = `You are a performance investigator for "Minimal Observation", a distributed-tracing APM.
Data model: services contain transactions (root spans / endpoints); transactions contain spans
(dependencies like db/external/messaging/fs, or custom internal timespans). Durations are milliseconds.
Investigate methodically: form a hypothesis, use tools to test it, and PIVOT — e.g. from a slow trace to
other slow traces of the same endpoint, to the same db statement across services, or compare fast vs slow
cohorts with duration filters ("how do quick requests differ from this one?"). Prefer run_sql for flexible
slicing. When done, give a concise root-cause analysis with concrete evidence (trace ids, statements,
percentiles) and recommended next steps. Keep tool arguments minimal; timestamps are epoch-ms and optional
(default is the last 24h).`;

function tools(): Anthropic.Tool[] {
  const timeRange = {
    from: { type: 'number', description: 'epoch ms (optional, default now-24h)' },
    to: { type: 'number', description: 'epoch ms (optional, default now)' },
  };
  return [
    { name: 'list_services', description: 'List services with latency/throughput/error summary.', input_schema: { type: 'object', properties: { ...timeRange } } },
    { name: 'list_endpoints', description: 'List a service\'s endpoints (transactions).', input_schema: { type: 'object', properties: { service: { type: 'string' }, ...timeRange }, required: ['service'] } },
    { name: 'get_endpoint', description: 'Endpoint summary (exact percentiles) + span-type breakdown.', input_schema: { type: 'object', properties: { service: { type: 'string' }, name: { type: 'string' }, ...timeRange }, required: ['service', 'name'] } },
    { name: 'list_traces', description: 'List matching transactions (single requests). Filter by service/name/status and duration.', input_schema: { type: 'object', properties: { service: { type: 'string' }, name: { type: 'string' }, status: { type: 'string', enum: ['OK', 'ERROR'] }, minDur: { type: 'number' }, maxDur: { type: 'number' }, limit: { type: 'number' }, ...timeRange } } },
    { name: 'get_trace', description: 'All spans of one trace (the waterfall) by trace id.', input_schema: { type: 'object', properties: { traceId: { type: 'string' } }, required: ['traceId'] } },
    { name: 'list_dependencies', description: 'List dependencies (db/external/messaging/fs) with summaries.', input_schema: { type: 'object', properties: { ...timeRange } } },
    { name: 'run_sql', description: 'Run a read-only DuckDB SELECT against a `spans` relation covering the retention window. Columns: trace_id, span_id, parent_id, service, name, kind, span_type, dependency, is_transaction, status, http_method, http_status, db_system, db_statement, db_rows, start_ns, end_ns, dur_ns, attrs.', input_schema: { type: 'object', properties: { sql: { type: 'string' } }, required: ['sql'] } },
  ];
}

const DAY = 86_400_000;

async function dispatch(store: DuckStore, name: string, input: any): Promise<unknown> {
  const to = input?.to ?? Date.now();
  const from = input?.from ?? to - DAY;
  switch (name) {
    case 'list_services': {
      const rows = (await store.getRollups(from, to)).filter((r) => r.is_transaction);
      const { groupSummaries } = await import('./aggregate.js');
      return [...groupSummaries(rows, (r) => r.service, to - from).entries()].map(([service, s]) => ({ service, count: s.count, p95Ms: round(s.p95Ms), errorRate: round(s.errorRate, 4), throughputPerMin: round(s.throughputPerMin) }));
    }
    case 'list_endpoints': {
      const rows = (await store.getRollups(from, to, { service: input.service })).filter((r) => r.is_transaction);
      const { groupSummaries } = await import('./aggregate.js');
      return [...groupSummaries(rows, (r) => r.name, to - from).entries()].map(([n, s]) => ({ name: n, count: s.count, p95Ms: round(s.p95Ms), p99Ms: round(s.p99Ms), errorRate: round(s.errorRate, 4) }));
    }
    case 'get_endpoint': {
      const [summary, bd] = await Promise.all([store.getEndpointSummary(input.service, input.name, from, to), store.getEndpointBreakdown(input.service, input.name, from, to)]);
      return { summary, breakdown: bd };
    }
    case 'list_traces':
      return store.getTraceList({ fromMs: from, toMs: to, service: input.service, name: input.name, status: input.status, minDurMs: input.minDur, maxDurMs: input.maxDur, limit: Math.min(input.limit ?? 50, 200) });
    case 'get_trace':
      return { spans: await store.getTrace(input.traceId) };
    case 'list_dependencies': {
      const rows = (await store.getRollups(from, to)).filter((r) => r.dependency);
      const { groupSummaries } = await import('./aggregate.js');
      return [...groupSummaries(rows, (r) => `${r.dependency}`, to - from).entries()].map(([dependency, s]) => ({ dependency, count: s.count, p95Ms: round(s.p95Ms), errorRate: round(s.errorRate, 4) }));
    }
    case 'run_sql':
      return store.runReadOnlySql(input.sql);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const round = (n: number, d = 1) => (typeof n === 'number' ? Math.round(n * 10 ** d) / 10 ** d : n);
const clip = (s: string, n = 12_000) => (s.length > n ? s.slice(0, n) + `\n…[truncated ${s.length - n} chars]` : s);

export interface AgentStep {
  tool: string;
  input: unknown;
  resultPreview: string;
}

export async function investigate(store: DuckStore, question: string, maxSteps = 12): Promise<{ answer: string; steps: AgentStep[] }> {
  if (!config.agent.apiKey) throw new Error('agent disabled: set ANTHROPIC_API_KEY');
  const client = new Anthropic({ apiKey: config.agent.apiKey });
  const steps: AgentStep[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];

  for (let i = 0; i < maxSteps; i++) {
    const res = await client.messages.create({ model: config.agent.model, max_tokens: 2048, system: SYSTEM, tools: tools(), messages });
    messages.push({ role: 'assistant', content: res.content });
    const toolUses = res.content.filter((c): c is Anthropic.ToolUseBlock => c.type === 'tool_use');
    if (toolUses.length === 0 || res.stop_reason !== 'tool_use') {
      const answer = res.content.filter((c) => c.type === 'text').map((c: any) => c.text).join('\n');
      return { answer, steps };
    }
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      let out: string;
      try {
        out = clip(JSON.stringify(await dispatch(store, tu.name, tu.input)));
      } catch (e: any) {
        out = `ERROR: ${e?.message ?? e}`;
      }
      steps.push({ tool: tu.name, input: tu.input, resultPreview: out.slice(0, 400) });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    }
    messages.push({ role: 'user', content: results });
  }
  return { answer: 'Investigation reached the step limit without a final conclusion.', steps };
}

export function registerAgent(app: FastifyInstance, store: DuckStore): void {
  app.post('/api/agent', { preHandler: requireApiKey }, async (req, reply) => {
    const question = (req.body as any)?.question;
    if (typeof question !== 'string' || !question.trim()) return reply.code(400).send({ error: 'question required' });
    if (!config.agent.apiKey) return reply.code(503).send({ error: 'AI agent disabled: set ANTHROPIC_API_KEY' });
    try {
      return await investigate(store, question);
    } catch (e: any) {
      return reply.code(500).send({ error: String(e?.message ?? e) });
    }
  });
}

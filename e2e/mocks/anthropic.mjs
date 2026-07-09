/**
 * Mock Anthropic Messages API for e2e — so the AI investigator can be tested
 * end-to-end without any external network call. Drives the REAL agent tool loop:
 * first response asks to call `list_services`, second response (after it sees the
 * tool_result) returns a final analysis. The server's agent code, tool dispatch,
 * and DuckDB queries are all exercised for real; only the LLM is faked.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_ANTHROPIC_PORT || 4390);

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

const server = createServer((req, res) => {
  if (req.url === '/health') return json(res, 200, { ok: true });
  if (!(req.method === 'POST' && req.url?.endsWith('/v1/messages'))) return json(res, 404, { error: 'not found' });

  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    const messages = body.messages || [];
    const sawToolResult = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b?.type === 'tool_result'));
    const base = { id: 'msg_mock', type: 'message', role: 'assistant', model: body.model || 'mock', usage: { input_tokens: 10, output_tokens: 10 } };

    if (!sawToolResult) {
      // First turn: call a tool so the real dispatch + DuckDB query runs.
      return json(res, 200, { ...base, stop_reason: 'tool_use', content: [
        { type: 'text', text: 'Let me look at the services.' },
        { type: 'tool_use', id: 'toolu_mock1', name: 'list_services', input: {} },
      ] });
    }
    // Second turn: final analysis referencing the (real) tool output.
    return json(res, 200, { ...base, stop_reason: 'end_turn', content: [
      { type: 'text', text: 'MOCK ANALYSIS: reviewed services via list_services; the checkout-service p95 is the hotspot. Recommend profiling its slowest endpoint.' },
    ] });
  });
});

server.listen(PORT, () => console.log(`mock-anthropic listening on :${PORT}`));

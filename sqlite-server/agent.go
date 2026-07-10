package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// The "Investigate performance issue" agent — an Anthropic Messages API tool-use loop over
// the same query primitives the UI uses, so it can pivot: from a slow trace to similar traces,
// to the same dependency across services, to fast-vs-slow cohorts. No SDK; raw HTTP.

const agentSystem = `You are a performance investigator for "Minimal Observation", a distributed-tracing APM.
Data model: services contain transactions (root spans / endpoints); transactions contain spans
(dependencies like db/external/messaging/fs, or custom internal timespans). Durations are milliseconds.
Investigate methodically: form a hypothesis, use tools to test it, and PIVOT — e.g. from a slow trace to
other slow traces of the same endpoint, to the same db statement across services, or compare fast vs slow
cohorts with duration filters. Prefer run_sql for flexible slicing. When done, give a concise root-cause
analysis with concrete evidence (trace ids, statements, percentiles) and next steps. Timestamps are
epoch-ms and optional (default is the last 24h).`

const dayMs = 86400000

func agentTools() []map[string]any {
	tr := map[string]any{
		"from": map[string]any{"type": "number", "description": "epoch ms (optional, default now-24h)"},
		"to":   map[string]any{"type": "number", "description": "epoch ms (optional, default now)"},
	}
	obj := func(props map[string]any, required ...string) map[string]any {
		m := map[string]any{"type": "object", "properties": props}
		if len(required) > 0 {
			m["required"] = required
		}
		return m
	}
	merge := func(extra map[string]any) map[string]any {
		m := map[string]any{"from": tr["from"], "to": tr["to"]}
		for k, v := range extra {
			m[k] = v
		}
		return m
	}
	str := map[string]any{"type": "string"}
	num := map[string]any{"type": "number"}
	return []map[string]any{
		{"name": "list_services", "description": "List services with latency/throughput/error summary.", "input_schema": obj(merge(nil))},
		{"name": "list_endpoints", "description": "List a service's endpoints (transactions).", "input_schema": obj(merge(map[string]any{"service": str}), "service")},
		{"name": "get_endpoint", "description": "Endpoint summary (exact percentiles) + span-type breakdown.", "input_schema": obj(merge(map[string]any{"service": str, "name": str}), "service", "name")},
		{"name": "list_traces", "description": "List matching transactions. Filter by service/name/status and duration (ms).", "input_schema": obj(merge(map[string]any{"service": str, "name": str, "status": str, "minDur": num, "maxDur": num, "limit": num}))},
		{"name": "get_trace", "description": "All spans of one trace (the waterfall) by trace id.", "input_schema": obj(map[string]any{"traceId": str}, "traceId")},
		{"name": "list_dependencies", "description": "List dependencies (db/external/messaging/fs) with summaries.", "input_schema": obj(merge(nil))},
		{"name": "run_sql", "description": "Run a read-only SELECT against a `spans` table. Columns: trace_id, span_id, parent_id, service, name, kind, span_type, dependency, is_transaction, status, http_method, http_status, db_system, db_statement, db_rows, start_ns, end_ns, dur_ns, attrs.", "input_schema": obj(map[string]any{"sql": str}, "sql")},
	}
}

func round(n float64, d int) float64 {
	p := 1.0
	for i := 0; i < d; i++ {
		p *= 10
	}
	return float64(int64(n*p+0.5)) / p
}

func agentTimeRange(input map[string]any) (int64, int64) {
	to := time.Now().UnixMilli()
	if v, ok := input["to"].(float64); ok {
		to = int64(v)
	}
	from := to - dayMs
	if v, ok := input["from"].(float64); ok {
		from = int64(v)
	}
	return from, to
}

func (s *Store) agentDispatch(name string, input map[string]any) (any, error) {
	from, to := agentTimeRange(input)
	getStr := func(k string) string {
		if v, ok := input[k].(string); ok {
			return v
		}
		return ""
	}
	getNum := func(k string) float64 {
		if v, ok := input[k].(float64); ok {
			return v
		}
		return 0
	}
	switch name {
	case "list_services":
		rows, _ := s.getRollups(from, to, "", "")
		g := groupSummaries(rows, func(r RollupRow) (string, bool) { return r.Service, r.IsTransaction }, to-from)
		out := []map[string]any{}
		for svc, sum := range g {
			out = append(out, map[string]any{"service": svc, "count": sum.Count, "p95Ms": round(sum.P95Ms, 1), "errorRate": round(sum.ErrorRate, 4), "throughputPerMin": round(sum.ThroughputPerMin, 1)})
		}
		return out, nil
	case "list_endpoints":
		rows, _ := s.getRollups(from, to, getStr("service"), "")
		g := groupSummaries(rows, func(r RollupRow) (string, bool) { return r.Name, r.IsTransaction }, to-from)
		out := []map[string]any{}
		for n, sum := range g {
			out = append(out, map[string]any{"name": n, "count": sum.Count, "p95Ms": round(sum.P95Ms, 1), "p99Ms": round(sum.P99Ms, 1), "errorRate": round(sum.ErrorRate, 4)})
		}
		return out, nil
	case "get_endpoint":
		summary, _ := s.getEndpointSummary(getStr("service"), getStr("name"), from, to)
		bd, _ := s.getEndpointBreakdown(getStr("service"), getStr("name"), from, to)
		return map[string]any{"summary": summary, "breakdown": bd}, nil
	case "list_traces":
		return s.getTraceList(from, to, getStr("service"), getStr("name"), getStr("status"), getNum("minDur"), getNum("maxDur"), int(getNum("limit")))
	case "get_trace":
		spans, _ := s.getTrace(getStr("traceId"), 0)
		return map[string]any{"spans": spans}, nil
	case "list_dependencies":
		rows, _ := s.getRollups(from, to, "", "")
		var dep []RollupRow
		for _, r := range rows {
			if r.Dependency != "" {
				dep = append(dep, r)
			}
		}
		g := groupSummaries(dep, func(r RollupRow) (string, bool) { return r.Dependency, true }, to-from)
		out := []map[string]any{}
		for d, sum := range g {
			out = append(out, map[string]any{"dependency": d, "count": sum.Count, "p95Ms": round(sum.P95Ms, 1), "errorRate": round(sum.ErrorRate, 4)})
		}
		return out, nil
	case "run_sql":
		return s.runReadOnlySQL(getStr("sql"))
	}
	return nil, fmt.Errorf("unknown tool %s", name)
}

type AgentStep struct {
	Tool          string `json:"tool"`
	Input         any    `json:"input"`
	ResultPreview string `json:"resultPreview"`
}

type anthropicResp struct {
	Content    json.RawMessage `json:"content"`
	StopReason string          `json:"stop_reason"`
	Error      *struct {
		Message string `json:"message"`
	} `json:"error"`
}
type contentBlock struct {
	Type  string          `json:"type"`
	Text  string          `json:"text"`
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

func clip(s string, n int) string {
	if len(s) > n {
		return s[:n] + fmt.Sprintf("\n…[truncated %d chars]", len(s)-n)
	}
	return s
}

func investigate(cfg Config, store *Store, question string) (string, []AgentStep, error) {
	if cfg.AgentAPIKey == "" {
		return "", nil, fmt.Errorf("agent disabled: set ANTHROPIC_API_KEY")
	}
	client := &http.Client{Timeout: 120 * time.Second}
	url := strings.TrimRight(cfg.AgentBaseURL, "/") + "/v1/messages"
	var steps []AgentStep
	messages := []map[string]any{{"role": "user", "content": question}}
	const maxSteps = 12

	for i := 0; i < maxSteps; i++ {
		reqBody, _ := json.Marshal(map[string]any{
			"model": cfg.AgentModel, "max_tokens": 2048, "system": agentSystem,
			"tools": agentTools(), "messages": messages,
		})
		req, _ := http.NewRequestWithContext(context.Background(), "POST", url, bytes.NewReader(reqBody))
		req.Header.Set("content-type", "application/json")
		req.Header.Set("x-api-key", cfg.AgentAPIKey)
		req.Header.Set("anthropic-version", "2023-06-01")
		resp, err := client.Do(req)
		if err != nil {
			return "", steps, err
		}
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var ar anthropicResp
		if err := json.Unmarshal(raw, &ar); err != nil {
			return "", steps, fmt.Errorf("bad anthropic response: %s", clip(string(raw), 200))
		}
		if ar.Error != nil {
			return "", steps, fmt.Errorf("anthropic error: %s", ar.Error.Message)
		}
		var blocks []contentBlock
		json.Unmarshal(ar.Content, &blocks)

		if ar.StopReason != "tool_use" {
			var text []string
			for _, b := range blocks {
				if b.Type == "text" {
					text = append(text, b.Text)
				}
			}
			return strings.Join(text, "\n"), steps, nil
		}

		messages = append(messages, map[string]any{"role": "assistant", "content": ar.Content})
		var results []map[string]any
		for _, b := range blocks {
			if b.Type != "tool_use" {
				continue
			}
			var input map[string]any
			json.Unmarshal(b.Input, &input)
			var out string
			if res, err := store.agentDispatch(b.Name, input); err != nil {
				out = "ERROR: " + err.Error()
			} else {
				j, _ := json.Marshal(res)
				out = clip(string(j), 12000)
			}
			steps = append(steps, AgentStep{Tool: b.Name, Input: input, ResultPreview: clip(out, 400)})
			results = append(results, map[string]any{"type": "tool_result", "tool_use_id": b.ID, "content": out})
		}
		messages = append(messages, map[string]any{"role": "user", "content": results})
	}
	return "Investigation reached the step limit without a final conclusion.", steps, nil
}

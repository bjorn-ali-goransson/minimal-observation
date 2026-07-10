package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

type Server struct {
	cfg   Config
	store *Store
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func (s *Server) extractKey(r *http.Request) string {
	if k := r.Header.Get("x-api-key"); k != "" {
		return k
	}
	if a := r.Header.Get("authorization"); a != "" {
		for _, p := range []string{"ApiKey ", "Bearer ", "apikey ", "bearer "} {
			if strings.HasPrefix(a, p) {
				return strings.TrimSpace(a[len(p):])
			}
		}
	}
	return r.URL.Query().Get("k")
}

// rng parses from/to (epoch ms), defaulting to the last hour.
func rng(r *http.Request) (from, to, window int64) {
	q := r.URL.Query()
	to = time.Now().UnixMilli()
	if v := q.Get("to"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			to = n
		}
	}
	from = to - 3600000
	if v := q.Get("from"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			from = n
		}
	}
	window = to - from
	if window < 1 {
		window = 1
	}
	return
}

func qf(r *http.Request, key string) float64 {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.ParseFloat(v, 64); err == nil {
			return n
		}
	}
	return 0
}
func qi(r *http.Request, key string, d int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return d
}

type namedSummary struct {
	Key string `json:"-"`
	Summary
}

func (s *Server) routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"ok": true})
	})
	mux.HandleFunc("GET /api/meta", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"currentDay": s.store.currentDay, "retentionDays": s.cfg.RetentionDays,
			"coldKind": s.cfg.ColdKind, "agentEnabled": s.cfg.AgentEnabled, "impl": "go-sqlite",
		})
	})

	mux.HandleFunc("GET /api/services", func(w http.ResponseWriter, r *http.Request) {
		from, to, window := rng(r)
		rows, err := s.store.getRollups(from, to, "", "")
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		groups := groupSummaries(rows, func(rr RollupRow) (string, bool) {
			return rr.Service, rr.IsTransaction
		}, window)
		type row struct {
			Service string `json:"service"`
			Summary
		}
		out := []row{}
		for k, v := range groups {
			out = append(out, row{Service: k, Summary: v})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("GET /api/services/{service}/endpoints", func(w http.ResponseWriter, r *http.Request) {
		from, to, window := rng(r)
		service := r.PathValue("service")
		rows, _ := s.store.getRollups(from, to, service, "")
		groups := groupSummaries(rows, func(rr RollupRow) (string, bool) {
			return rr.Name, rr.IsTransaction
		}, window)
		type row struct {
			Name string `json:"name"`
			Summary
		}
		out := []row{}
		for k, v := range groups {
			out = append(out, row{Name: k, Summary: v})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("GET /api/endpoint", func(w http.ResponseWriter, r *http.Request) {
		from, to, window := rng(r)
		service := r.URL.Query().Get("service")
		name := r.URL.Query().Get("name")
		rollups, _ := s.store.getRollups(from, to, service, name)
		var txRows []RollupRow
		for _, rr := range rollups {
			if rr.IsTransaction {
				txRows = append(txRows, rr)
			}
		}
		summary, _ := s.store.getEndpointSummary(service, name, from, to)
		bd, _ := s.store.getEndpointBreakdown(service, name, from, to)
		total := 0.0
		for _, b := range bd {
			total += toF(b["ms"])
		}
		if total == 0 {
			total = 1
		}
		bdOut := []map[string]any{}
		for _, b := range bd {
			bdOut = append(bdOut, map[string]any{"type": b["span_type"], "n": b["n"], "ms": b["ms"], "fraction": toF(b["ms"]) / total})
		}
		tp := 0.0
		if window > 0 {
			tp = toF(summary["n"]) / (float64(window) / 60000.0)
		}
		writeJSON(w, 200, map[string]any{
			"service": service, "name": name,
			"summary":          summary,
			"throughputPerMin": tp,
			"series": map[string]any{
				"throughput": timeseries(txRows, "throughput"),
				"p50":        timeseries(txRows, "p50"),
				"p95":        timeseries(txRows, "p95"),
				"p99":        timeseries(txRows, "p99"),
				"errorRate":  timeseries(txRows, "errorRate"),
			},
			"breakdown": bdOut,
		})
	})

	mux.HandleFunc("GET /api/traces", func(w http.ResponseWriter, r *http.Request) {
		from, to, _ := rng(r)
		q := r.URL.Query()
		rows, err := s.store.getTraceList(from, to, q.Get("service"), q.Get("name"), q.Get("status"), qf(r, "minDur"), qf(r, "maxDur"), qi(r, "limit", 100))
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, emptyIfNil(rows))
	})

	mux.HandleFunc("GET /api/trace/{traceId}", func(w http.ResponseWriter, r *http.Request) {
		var dayHint int64
		if v := r.URL.Query().Get("day"); v != "" {
			dayHint, _ = strconv.ParseInt(v, 10, 64)
		}
		spans, _ := s.store.getTrace(r.PathValue("traceId"), dayHint)
		for _, sp := range spans {
			if str, ok := sp["attrs"].(string); ok {
				var m any
				if json.Unmarshal([]byte(str), &m) == nil {
					sp["attrs"] = m
				}
			}
		}
		writeJSON(w, 200, map[string]any{"spans": emptyIfNil(spans)})
	})

	mux.HandleFunc("GET /api/dependencies", func(w http.ResponseWriter, r *http.Request) {
		from, to, window := rng(r)
		rows, _ := s.store.getRollups(from, to, "", "")
		var depRows []RollupRow
		for _, rr := range rows {
			if rr.Dependency != "" {
				depRows = append(depRows, rr)
			}
		}
		groups := groupSummaries(depRows, func(rr RollupRow) (string, bool) {
			return rr.Dependency + " " + rr.SpanType, true
		}, window)
		type row struct {
			Dependency string `json:"dependency"`
			SpanType   string `json:"span_type"`
			Summary
		}
		out := []row{}
		for k, v := range groups {
			parts := strings.SplitN(k, " ", 2)
			st := ""
			if len(parts) > 1 {
				st = parts[1]
			}
			out = append(out, row{Dependency: parts[0], SpanType: st, Summary: v})
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Count > out[j].Count })
		writeJSON(w, 200, out)
	})

	mux.HandleFunc("GET /api/dependency", func(w http.ResponseWriter, r *http.Request) {
		from, to, window := rng(r)
		dep := r.URL.Query().Get("dependency")
		rows, _ := s.store.getRollups(from, to, "", "")
		overall := newAgg()
		var depRows []RollupRow
		for _, rr := range rows {
			if rr.Dependency == dep {
				overall.add(rr)
				depRows = append(depRows, rr)
			}
		}
		byService := groupSummaries(depRows, func(rr RollupRow) (string, bool) { return rr.Service, true }, window)
		type srow struct {
			Service string `json:"service"`
			Summary
		}
		bs := []srow{}
		for k, v := range byService {
			bs = append(bs, srow{Service: k, Summary: v})
		}
		sort.Slice(bs, func(i, j int) bool { return bs[i].Count > bs[j].Count })
		endpoints, _ := s.store.getDependencyEndpoints(dep, from, to)
		recent, _ := s.store.getDependencyTraces(dep, from, to, 50)
		writeJSON(w, 200, map[string]any{
			"dependency": dep, "summary": overall.summarize(window),
			"byService": bs, "endpoints": emptyIfNil(endpoints), "recent": emptyIfNil(recent),
		})
	})

	mux.HandleFunc("POST /api/query", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			SQL string `json:"sql"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if body.SQL == "" {
			writeJSON(w, 400, map[string]any{"error": "sql required"})
			return
		}
		res, err := s.store.runReadOnlySQL(body.SQL)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(w, 200, res)
	})

	mux.HandleFunc("GET /api/export", func(w http.ResponseWriter, r *http.Request) {
		from, to, _ := rng(r)
		q := r.URL.Query()
		rows, _ := s.store.exportSpans(from, to, q.Get("service"), q.Get("name"), q.Get("dependency"), q.Get("status"), qf(r, "minDur"), qi(r, "limit", 500))
		rows = emptyIfNil(rows).([]map[string]any)
		if q.Get("format") == "csv" {
			w.Header().Set("content-type", "text/csv")
			w.Write([]byte(toCSV(rows)))
			return
		}
		writeJSON(w, 200, map[string]any{"count": len(rows), "spans": rows})
	})

	mux.HandleFunc("POST /api/admin/freeze", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{"frozen": s.store.forceFreeze()})
	})

	mux.HandleFunc("POST /api/agent", func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Question string `json:"question"`
		}
		json.NewDecoder(r.Body).Decode(&body)
		if strings.TrimSpace(body.Question) == "" {
			writeJSON(w, 400, map[string]any{"error": "question required"})
			return
		}
		if !s.cfg.AgentEnabled {
			writeJSON(w, 503, map[string]any{"error": "AI agent disabled: set ANTHROPIC_API_KEY"})
			return
		}
		answer, steps, err := investigate(s.cfg, s.store, body.Question)
		if err != nil {
			writeJSON(w, 500, map[string]any{"error": err.Error()})
			return
		}
		if steps == nil {
			steps = []AgentStep{}
		}
		writeJSON(w, 200, map[string]any{"answer": answer, "steps": steps})
	})

	mux.HandleFunc("POST /v1/traces", func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": "read body"})
			return
		}
		spans, err := parseOtlpTraces(body)
		if err != nil {
			writeJSON(w, 400, map[string]any{"error": err.Error()})
			return
		}
		s.store.ingest(spans)
		writeJSON(w, 200, map[string]any{"partialSuccess": map[string]any{}})
	})

	// Static UI + SPA fallback.
	s.registerStatic(mux)

	return s.auth(mux)
}

func (s *Server) registerStatic(mux *http.ServeMux) {
	if s.cfg.UIDir == "" {
		return
	}
	if _, err := os.Stat(s.cfg.UIDir); err != nil {
		return
	}
	fs := http.FileServer(http.Dir(s.cfg.UIDir))
	mux.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if strings.HasPrefix(p, "/api") || strings.HasPrefix(p, "/v1") {
			writeJSON(w, 404, map[string]any{"error": "not found"})
			return
		}
		if p != "/" {
			if _, err := os.Stat(filepath.Join(s.cfg.UIDir, filepath.Clean(p))); err == nil {
				fs.ServeHTTP(w, r)
				return
			}
		}
		http.ServeFile(w, r, filepath.Join(s.cfg.UIDir, "index.html"))
	})
}

func (s *Server) auth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("access-control-allow-origin", "*")
		w.Header().Set("access-control-allow-headers", "*")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		p := r.URL.Path
		protected := (strings.HasPrefix(p, "/api/") && p != "/api/health") || strings.HasPrefix(p, "/v1/")
		if protected && s.extractKey(r) != s.cfg.APIKey {
			writeJSON(w, 401, map[string]any{"error": "unauthorized"})
			return
		}
		next.ServeHTTP(w, r)
	})
}

func toF(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case int64:
		return float64(t)
	case int:
		return float64(t)
	}
	return 0
}

func emptyIfNil(rows []map[string]any) any {
	if rows == nil {
		return []map[string]any{}
	}
	return rows
}

func toCSV(rows []map[string]any) string {
	if len(rows) == 0 {
		return ""
	}
	var cols []string
	for c := range rows[0] {
		cols = append(cols, c)
	}
	sort.Strings(cols)
	esc := func(v any) string {
		s := ""
		if v != nil {
			s = fmt.Sprintf("%v", v)
		}
		if strings.ContainsAny(s, ",\"\n") {
			return "\"" + strings.ReplaceAll(s, "\"", "\"\"") + "\""
		}
		return s
	}
	var b strings.Builder
	b.WriteString(strings.Join(cols, ","))
	for _, row := range rows {
		b.WriteByte('\n')
		for i, c := range cols {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(esc(row[c]))
		}
	}
	return b.String()
}

package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Store — SQLite for raw spans (trace lookup, filtered scans, custom SQL) + in-process
// rollups (mergeable histograms) for the overview/chart/percentile screens. The rollups
// need no engine at all, so SQLite only carries the ad-hoc-SQL + retention weight.
//
// Spike scope: no cold tier (single retention-swept SQLite file); overview percentiles are
// histogram-approximate, endpoint-detail percentiles are exact (computed in Go).
type Store struct {
	cfg        Config
	db         *sql.DB
	mu         sync.Mutex
	buffer     []Span
	currentDay string

	rmu     sync.Mutex
	rollups map[rollupKey]*rollupAgg
}

type rollupKey struct {
	Hour       int64
	Service    string
	Name       string
	SpanType   string
	Dependency string
	IsTx       bool
}
type rollupAgg struct {
	N        int64
	Errors   int64
	SumDurNs float64
	Hist     []int
}

type RollupRow struct {
	HourMs        int64
	Service       string
	Name          string
	SpanType      string
	IsTransaction bool
	Dependency    string
	N             int64
	Errors        int64
	SumDurNs      float64
	Buckets       []int
	Counts        []int
}

func q(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func dayOf(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02") }
func today() string         { return dayOf(time.Now().UnixMilli()) }

const createSQL = `
CREATE TABLE IF NOT EXISTS spans(
 trace_id TEXT, span_id TEXT, parent_id TEXT, service TEXT, service_version TEXT, environment TEXT,
 name TEXT, kind TEXT, is_transaction INTEGER, span_type TEXT, dependency TEXT,
 start_ns INTEGER, end_ns INTEGER, dur_ns INTEGER, status TEXT, status_message TEXT,
 http_method TEXT, http_status INTEGER, db_system TEXT, db_statement TEXT, db_rows INTEGER, attrs TEXT);
CREATE INDEX IF NOT EXISTS idx_txn ON spans(service, name, start_ns) WHERE is_transaction=1;
CREATE INDEX IF NOT EXISTS idx_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_dep ON spans(dependency, start_ns);
CREATE INDEX IF NOT EXISTS idx_time ON spans(start_ns);`

func newStore(cfg Config) (*Store, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	dsn := filepath.Join(cfg.DataDir, "spans.sqlite")
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // single writer; keeps SQLite simple and memory tiny
	for _, p := range []string{
		"PRAGMA journal_mode=WAL", "PRAGMA synchronous=OFF", // loss is acceptable by design
		"PRAGMA cache_size=-2000", // ~2MB page cache — deliberately small
		"PRAGMA temp_store=MEMORY", "PRAGMA busy_timeout=5000",
	} {
		if _, err := db.Exec(p); err != nil {
			return nil, err
		}
	}
	if _, err := db.Exec(createSQL); err != nil {
		return nil, err
	}
	s := &Store{cfg: cfg, db: db, currentDay: today(), rollups: map[rollupKey]*rollupAgg{}}
	if err := s.rebuildRollups(); err != nil {
		return nil, err
	}
	go s.loops()
	return s, nil
}

func (s *Store) loops() {
	flush := time.NewTicker(time.Duration(s.cfg.FlushMaxMs) * time.Millisecond)
	maint := time.NewTicker(60 * time.Second)
	for {
		select {
		case <-flush.C:
			s.flush()
		case <-maint.C:
			s.maintenance()
		}
	}
}

// ---- ingestion ----

func (s *Store) ingest(spans []Span) {
	s.mu.Lock()
	s.buffer = append(s.buffer, spans...)
	over := len(s.buffer) >= s.cfg.FlushMaxRows
	s.mu.Unlock()
	if over {
		s.flush()
	}
}

func b2i(b bool) int {
	if b {
		return 1
	}
	return 0
}

func (s *Store) flush() {
	s.mu.Lock()
	if len(s.buffer) == 0 {
		s.mu.Unlock()
		return
	}
	if now := today(); now != s.currentDay {
		s.currentDay = now
	}
	batch := s.buffer
	s.buffer = nil
	s.mu.Unlock()

	tx, err := s.db.Begin()
	if err != nil {
		fmt.Fprintln(os.Stderr, "tx:", err)
		return
	}
	stmt, err := tx.Prepare("INSERT INTO spans VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
	if err != nil {
		tx.Rollback()
		return
	}
	s.rmu.Lock()
	for i := range batch {
		sp := &batch[i]
		attrs, _ := json.Marshal(sp.Attrs)
		var httpStatus any
		if sp.HTTPStatus != nil {
			httpStatus = *sp.HTTPStatus
		}
		if _, err := stmt.Exec(sp.TraceID, sp.SpanID, ns(sp.ParentID), sp.Service, ns(sp.ServiceVersion),
			ns(sp.Environment), sp.Name, sp.Kind, b2i(sp.IsTransaction), sp.SpanType, ns(sp.Dependency),
			sp.StartNs, sp.EndNs, sp.DurNs, sp.Status, ns(sp.StatusMessage), ns(sp.HTTPMethod),
			httpStatus, ns(sp.DBSystem), ns(sp.DBStatement), sp.DBRows, string(attrs)); err != nil {
			fmt.Fprintln(os.Stderr, "insert:", err)
		}
		dep := ""
		if sp.Dependency != nil {
			dep = *sp.Dependency
		}
		s.updateRollupLocked((sp.StartNs/3600000000000)*3600000, sp.Service, sp.Name, sp.SpanType, dep, sp.IsTransaction, sp.DurNs, sp.Status)
	}
	s.rmu.Unlock()
	stmt.Close()
	if err := tx.Commit(); err != nil {
		fmt.Fprintln(os.Stderr, "commit:", err)
	}
}

func ns(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func (s *Store) updateRollupLocked(hourMs int64, service, name, spanType, dep string, isTx bool, durNs int64, status string) {
	k := rollupKey{Hour: hourMs, Service: service, Name: name, SpanType: spanType, Dependency: dep, IsTx: isTx}
	a := s.rollups[k]
	if a == nil {
		a = &rollupAgg{Hist: make([]int, bucketCount)}
		s.rollups[k] = a
	}
	a.N++
	if status == "ERROR" {
		a.Errors++
	}
	a.SumDurNs += float64(durNs)
	a.Hist[bucketIndex(float64(durNs)/1e6)]++
}

func (s *Store) rebuildRollups() error {
	rows, err := s.db.Query("SELECT start_ns, service, name, span_type, coalesce(dependency,''), is_transaction, dur_ns, status FROM spans")
	if err != nil {
		return err
	}
	defer rows.Close()
	s.rmu.Lock()
	defer s.rmu.Unlock()
	for rows.Next() {
		var startNs, durNs int64
		var service, name, spanType, dep, status string
		var isTx int
		if err := rows.Scan(&startNs, &service, &name, &spanType, &dep, &isTx, &durNs, &status); err != nil {
			return err
		}
		s.updateRollupLocked((startNs/3600000000000)*3600000, service, name, spanType, dep, isTx == 1, durNs, status)
	}
	return rows.Err()
}

// ---- rollups (from memory) ----

func (s *Store) getRollups(fromMs, toMs int64, service, name string) ([]RollupRow, error) {
	hourFrom := (fromMs / 3600000) * 3600000
	s.rmu.Lock()
	defer s.rmu.Unlock()
	var out []RollupRow
	for k, a := range s.rollups {
		if k.Hour < hourFrom || k.Hour > toMs {
			continue
		}
		if service != "" && k.Service != service {
			continue
		}
		if name != "" && k.Name != name {
			continue
		}
		var buckets, counts []int
		for i, c := range a.Hist {
			if c > 0 {
				buckets = append(buckets, i)
				counts = append(counts, c)
			}
		}
		out = append(out, RollupRow{
			HourMs: k.Hour, Service: k.Service, Name: k.Name, SpanType: k.SpanType,
			IsTransaction: k.IsTx, Dependency: k.Dependency, N: a.N, Errors: a.Errors,
			SumDurNs: a.SumDurNs, Buckets: buckets, Counts: counts,
		})
	}
	return out, nil
}

// ---- raw queries ----

func (s *Store) queryAll(query string, args ...any) ([]map[string]any, error) {
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	var out []map[string]any
	for rows.Next() {
		vals := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range vals {
			ptrs[i] = &vals[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			return nil, err
		}
		m := map[string]any{}
		for i, c := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				v = string(b)
			}
			m[c] = v
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func timeWhere(fromMs, toMs int64) string {
	return fmt.Sprintf("start_ns >= %d AND start_ns <= %d", fromMs*1000000, toMs*1000000)
}

func (s *Store) getTraceList(fromMs, toMs int64, service, name, status string, minDur, maxDur float64, limit int) ([]map[string]any, error) {
	w := []string{"is_transaction=1", timeWhere(fromMs, toMs)}
	if service != "" {
		w = append(w, "service="+q(service))
	}
	if name != "" {
		w = append(w, "name="+q(name))
	}
	if status != "" {
		w = append(w, "status="+q(status))
	}
	if minDur > 0 {
		w = append(w, fmt.Sprintf("dur_ns >= %d", int64(minDur*1e6)))
	}
	if maxDur > 0 {
		w = append(w, fmt.Sprintf("dur_ns <= %d", int64(maxDur*1e6)))
	}
	if limit <= 0 || limit > 1000 {
		limit = 100
	}
	return s.queryAll(fmt.Sprintf(`SELECT trace_id, span_id, service, name, http_method, http_status, status,
		start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms FROM spans WHERE %s ORDER BY start_ns DESC LIMIT %d`,
		strings.Join(w, " AND "), limit))
}

func (s *Store) getTrace(traceID string, dayHintMs int64) ([]map[string]any, error) {
	return s.queryAll(`SELECT trace_id, span_id, parent_id, service, name, kind, span_type, dependency,
		is_transaction, status, status_message, http_method, http_status, db_system, db_statement, db_rows,
		start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms, attrs FROM spans WHERE trace_id=? ORDER BY start_ns`, traceID)
}

func (s *Store) getDependencyTraces(dep string, fromMs, toMs int64, limit int) ([]map[string]any, error) {
	return s.queryAll(fmt.Sprintf(`SELECT trace_id, span_id, service, name, dependency, span_type, status,
		db_statement, db_rows, start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms FROM spans
		WHERE dependency=%s AND start_ns >= %d ORDER BY start_ns DESC LIMIT %d`, q(dep), fromMs*1e6, limit))
}

func contQuantile(sorted []float64, qq float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n == 1 {
		return sorted[0]
	}
	pos := qq * float64(n-1)
	lo := int(pos)
	frac := pos - float64(lo)
	if lo+1 >= n {
		return sorted[n-1]
	}
	return sorted[lo] + (sorted[lo+1]-sorted[lo])*frac
}

// getEndpointSummary computes EXACT percentiles in Go (SQLite has no quantile_cont).
func (s *Store) getEndpointSummary(service, name string, fromMs, toMs int64) (map[string]any, error) {
	rows, err := s.db.Query(fmt.Sprintf(`SELECT dur_ns, status FROM spans
		WHERE is_transaction=1 AND service=%s AND name=%s AND %s ORDER BY dur_ns LIMIT 200000`,
		q(service), q(name), timeWhere(fromMs, toMs)))
	if err != nil {
		return map[string]any{}, err
	}
	defer rows.Close()
	var durs []float64
	var errors int64
	for rows.Next() {
		var d int64
		var st string
		rows.Scan(&d, &st)
		durs = append(durs, float64(d)/1e6)
		if st == "ERROR" {
			errors++
		}
	}
	n := len(durs)
	if n == 0 {
		return map[string]any{"n": 0, "errors": 0}, nil
	}
	sum := 0.0
	for _, d := range durs {
		sum += d
	}
	return map[string]any{
		"n": n, "errors": errors,
		"p50": contQuantile(durs, 0.5), "p90": contQuantile(durs, 0.9),
		"p95": contQuantile(durs, 0.95), "p99": contQuantile(durs, 0.99),
		"avg": sum / float64(n), "min": durs[0], "max": durs[n-1],
	}, nil
}

func (s *Store) getEndpointBreakdown(service, name string, fromMs, toMs int64) ([]map[string]any, error) {
	return s.queryAll(fmt.Sprintf(`WITH txn AS (SELECT DISTINCT trace_id FROM spans
		WHERE is_transaction=1 AND service=%s AND name=%s AND %s LIMIT 300)
		SELECT span_type, count(*) AS n, sum(dur_ns)/1e6 AS ms FROM spans
		WHERE trace_id IN (SELECT trace_id FROM txn) GROUP BY span_type ORDER BY ms DESC`,
		q(service), q(name), timeWhere(fromMs, toMs)))
}

func (s *Store) getDependencyEndpoints(dep string, fromMs, toMs int64) ([]map[string]any, error) {
	return s.queryAll(fmt.Sprintf(`WITH d AS (SELECT DISTINCT trace_id FROM spans WHERE dependency=%s AND %s LIMIT 500)
		SELECT service, name, count(*) AS n, avg(dur_ns)/1e6 AS avg_ms FROM spans
		WHERE is_transaction=1 AND trace_id IN (SELECT trace_id FROM d)
		GROUP BY service, name ORDER BY n DESC LIMIT 20`, q(dep), timeWhere(fromMs, toMs)))
}

func (s *Store) exportSpans(fromMs, toMs int64, service, name, dep, status string, minDur float64, limit int) ([]map[string]any, error) {
	w := []string{timeWhere(fromMs, toMs)}
	if service != "" {
		w = append(w, "service="+q(service))
	}
	if name != "" {
		w = append(w, "name="+q(name))
	}
	if dep != "" {
		w = append(w, "dependency="+q(dep))
	}
	if status != "" {
		w = append(w, "status="+q(status))
	}
	if minDur > 0 {
		w = append(w, fmt.Sprintf("dur_ns >= %d", int64(minDur*1e6)))
	}
	if limit <= 0 || limit > 5000 {
		limit = 500
	}
	return s.queryAll(fmt.Sprintf(`SELECT trace_id, span_id, parent_id, service, name, kind, span_type, dependency,
		status, db_statement, db_rows, http_method, http_status, round(dur_ns/1e6,3) AS dur_ms, start_ns/1e6 AS start_ms
		FROM spans WHERE %s ORDER BY start_ns DESC LIMIT %d`, strings.Join(w, " AND "), limit))
}

var deniedRe = regexp.MustCompile(`(?i)\b(insert|update|delete|drop|create|alter|attach|copy|install|load|pragma|export|import|call|vacuum|reindex)\b`)

func (s *Store) runReadOnlySQL(query string) (map[string]any, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(query), "; \n\t")
	low := strings.ToLower(trimmed)
	if !(strings.HasPrefix(low, "select") || strings.HasPrefix(low, "with")) {
		return nil, fmt.Errorf("only read-only SELECT/WITH queries are allowed")
	}
	if m := deniedRe.FindString(low); m != "" {
		return nil, fmt.Errorf("query contains a disallowed keyword: %s", m)
	}
	suffix := " LIMIT 5000"
	if regexp.MustCompile(`(?i)\blimit\s+\d+\s*$`).MatchString(trimmed) {
		suffix = ""
	}
	wrapped := trimmed + suffix
	probe, err := s.db.Query(wrapped)
	if err != nil {
		return nil, err
	}
	cols, _ := probe.Columns()
	probe.Close()
	data, err := s.queryAll(wrapped)
	if err != nil {
		return nil, err
	}
	if data == nil {
		data = []map[string]any{}
	}
	return map[string]any{"columns": cols, "rows": data}, nil
}

func (s *Store) forceFreeze() string {
	s.flush()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.currentDay // spike: no cold tier; retention handled by the sweeper
}

func (s *Store) maintenance() {
	cutoffMs := time.Now().UnixMilli() - int64(s.cfg.RetentionDays)*86400000
	s.db.Exec(fmt.Sprintf("DELETE FROM spans WHERE start_ns < %d", cutoffMs*1000000))
	s.rmu.Lock()
	for k := range s.rollups {
		if k.Hour < cutoffMs {
			delete(s.rollups, k)
		}
	}
	s.rmu.Unlock()
}

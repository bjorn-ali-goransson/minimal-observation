package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	duckdb "github.com/marcboeker/go-duckdb/v2"
)

// Store is the tiered DuckDB store — port of packages/server/src/store/DuckStore.ts.
// RAM micro-batch -> warm DuckDB (spans + hourly histogram rollups) -> cold day Parquet.
type Store struct {
	cfg        Config
	db         *sql.DB
	connector  *duckdb.Connector
	appendConn driver.Conn

	mu         sync.Mutex
	buffer     []Span
	currentDay string
	frozen     map[string]bool
	unpacked   map[string]int64 // day -> lastAccess unix ms
	coldBase   string
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

func bucketExpr(col string) string {
	return fmt.Sprintf("CASE WHEN %s <= 250000 THEN 0 ELSE least(%d, greatest(0, cast(ceil(ln((%s/1e6)/0.25)/ln(1.5)) AS INTEGER))) END",
		col, bucketCount-1, col)
}

// ---- time helpers (server-local day partitioning) ----

func dayOf(ms int64) string { return time.UnixMilli(ms).Format("2006-01-02") }
func today() string         { return dayOf(time.Now().UnixMilli()) }
func dayStartMs(ms int64) int64 {
	t := time.UnixMilli(ms)
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, time.Local).UnixMilli()
}
func nextMidnightMs(ms int64) int64 {
	t := time.UnixMilli(ms)
	return time.Date(t.Year(), t.Month(), t.Day()+1, 0, 0, 0, 0, time.Local).UnixMilli()
}
func daysBetween(fromMs, toMs int64, maxDays int) []string {
	var days []string
	cur := dayStartMs(fromMs)
	end := dayStartMs(toMs)
	for cur <= end && len(days) < maxDays {
		days = append(days, dayOf(cur))
		cur = nextMidnightMs(cur)
	}
	return days
}
func relTableForDay(day string) string { return "d_" + strings.ReplaceAll(day, "-", "_") }

func newStore(cfg Config) (*Store, error) {
	if err := os.MkdirAll(cfg.DataDir, 0o755); err != nil {
		return nil, err
	}
	connector, err := duckdb.NewConnector(filepath.Join(cfg.DataDir, "warm.duckdb"), nil)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	appendConn, err := connector.Connect(context.Background())
	if err != nil {
		return nil, err
	}
	s := &Store{
		cfg: cfg, db: db, connector: connector, appendConn: appendConn,
		currentDay: today(), frozen: map[string]bool{}, unpacked: map[string]int64{},
		coldBase: filepath.Join(cfg.DataDir, "cold"),
	}
	os.MkdirAll(s.coldBase, 0o755)
	for _, stmt := range []string{
		"SET memory_limit='512MB'", "SET threads=2",
		createSpansTable,
		`CREATE TABLE IF NOT EXISTS rollups(hour_ms BIGINT, service VARCHAR, name VARCHAR, span_type VARCHAR,
		  is_transaction BOOLEAN, dependency VARCHAR, n BIGINT, errors BIGINT, sum_dur_ns DOUBLE, buckets JSON, counts JSON)`,
		`CREATE TABLE IF NOT EXISTS frozen_days(day VARCHAR PRIMARY KEY)`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			return nil, fmt.Errorf("init %q: %w", stmt, err)
		}
	}
	rows, _ := db.Query("SELECT day FROM frozen_days")
	for rows != nil && rows.Next() {
		var d string
		rows.Scan(&d)
		s.frozen[d] = true
	}
	if rows != nil {
		rows.Close()
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

func ptrOrNil(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}

func (s *Store) flush() {
	s.mu.Lock()
	if len(s.buffer) == 0 {
		s.mu.Unlock()
		return
	}
	batch := s.buffer
	s.buffer = nil
	s.rolloverIfNeededLocked()
	s.mu.Unlock()

	app, err := duckdb.NewAppenderFromConn(s.appendConn, "", "spans")
	if err != nil {
		fmt.Fprintln(os.Stderr, "appender:", err)
		return
	}
	for i := range batch {
		sp := &batch[i]
		attrs, _ := json.Marshal(sp.Attrs)
		var httpStatus any
		if sp.HTTPStatus != nil {
			httpStatus = int32(*sp.HTTPStatus)
		}
		err := app.AppendRow(
			sp.TraceID, sp.SpanID, ptrOrNil(sp.ParentID), sp.Service, ptrOrNil(sp.ServiceVersion),
			ptrOrNil(sp.Environment), sp.Name, sp.Kind, sp.IsTransaction, sp.SpanType, ptrOrNil(sp.Dependency),
			sp.StartNs, sp.EndNs, sp.DurNs, sp.Status, ptrOrNil(sp.StatusMessage), ptrOrNil(sp.HTTPMethod),
			httpStatus, ptrOrNil(sp.DBSystem), ptrOrNil(sp.DBStatement), sp.DBRows, string(attrs),
		)
		if err != nil {
			fmt.Fprintln(os.Stderr, "append row:", err)
		}
	}
	app.Flush()
	app.Close()
}

// ---- rollover / freeze / retention ----

func (s *Store) rolloverIfNeededLocked() {
	now := today()
	if now == s.currentDay {
		return
	}
	finished := s.currentDay
	s.currentDay = now
	go s.freezeDay(finished)
}

func (s *Store) rollupSelect(src string, whereHourMs *int64) string {
	where := ""
	if whereHourMs != nil {
		where = fmt.Sprintf("WHERE (start_ns // 3600000000000) * 3600000 >= %d", *whereHourMs)
	}
	// Casts matter: sum() over BIGINT yields HUGEINT, which the Go driver won't scan
	// into int64 — pin n/errors to BIGINT and sd to DOUBLE (the Node driver tolerated this).
	return fmt.Sprintf(`SELECT hour_ms, service, name, span_type, is_transaction, dependency,
		  sum(c)::BIGINT AS n, sum(errs)::BIGINT AS errors, sum(sd)::DOUBLE AS sum_dur_ns,
		  to_json(list(bucket))::VARCHAR AS buckets, to_json(list(c))::VARCHAR AS counts
		FROM (SELECT (start_ns // 3600000000000) * 3600000 AS hour_ms, service, name, span_type, is_transaction, dependency,
		        %s AS bucket, count(*)::BIGINT AS c,
		        sum(CASE WHEN status='ERROR' THEN 1 ELSE 0 END)::BIGINT AS errs, sum(dur_ns)::DOUBLE AS sd
		     FROM %s %s GROUP BY 1,2,3,4,5,6,7) GROUP BY 1,2,3,4,5,6`, bucketExpr("dur_ns"), src, where)
}

func (s *Store) freezeDay(day string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var cnt int64
	s.db.QueryRow("SELECT count(*) FROM spans").Scan(&cnt)
	if cnt == 0 {
		return
	}
	dir := filepath.Join(s.coldBase, "day="+day)
	os.MkdirAll(dir, 0o755)
	if _, err := s.db.Exec(fmt.Sprintf("COPY (SELECT * FROM spans) TO %s (FORMAT PARQUET, COMPRESSION ZSTD)", q(filepath.Join(dir, "data.parquet")))); err != nil {
		fmt.Fprintln(os.Stderr, "freeze copy:", err)
		return
	}
	s.db.Exec(fmt.Sprintf(`INSERT INTO rollups SELECT hour_ms, service, name, span_type, is_transaction, dependency, n, errors, sum_dur_ns, buckets, counts FROM (%s)`, s.rollupSelect("spans", nil)))
	s.db.Exec(fmt.Sprintf("INSERT OR IGNORE INTO frozen_days VALUES (%s)", q(day)))
	s.frozen[day] = true
	s.db.Exec("DELETE FROM spans")
	s.db.Exec("CHECKPOINT")
}

func (s *Store) forceFreeze() string {
	s.flush()
	s.mu.Lock()
	day := s.currentDay
	s.mu.Unlock()
	s.freezeDay(day)
	return day
}

func (s *Store) maintenance() {
	s.mu.Lock()
	s.rolloverIfNeededLocked()
	now := time.Now().UnixMilli()
	for day, last := range s.unpacked {
		if now-last > int64(s.cfg.ColdIdleMs) {
			s.db.Exec("DROP TABLE IF EXISTS " + relTableForDay(day))
			delete(s.unpacked, day)
		}
	}
	s.mu.Unlock()
	cutoff := dayOf(now - int64(s.cfg.RetentionDays)*86400000)
	rows, _ := s.db.Query("SELECT day FROM frozen_days ORDER BY day")
	var drop []string
	for rows != nil && rows.Next() {
		var d string
		rows.Scan(&d)
		if d < cutoff {
			drop = append(drop, d)
		}
	}
	if rows != nil {
		rows.Close()
	}
	for _, d := range drop {
		os.RemoveAll(filepath.Join(s.coldBase, "day="+d))
		s.mu.Lock()
		delete(s.frozen, d)
		s.mu.Unlock()
		s.db.Exec(fmt.Sprintf("DELETE FROM frozen_days WHERE day=%s", q(d)))
	}
	if t, err := time.Parse("2006-01-02", cutoff); err == nil {
		s.db.Exec(fmt.Sprintf("DELETE FROM rollups WHERE hour_ms < %d", t.UnixMilli()))
	}
}

// ---- cold unpack ----

func (s *Store) coldExists(day string) bool {
	_, err := os.Stat(filepath.Join(s.coldBase, "day="+day, "data.parquet"))
	return err == nil
}

func (s *Store) ensureUnpackedLocked(day string) string {
	if day == s.currentDay && !s.frozen[day] {
		return "spans"
	}
	rel := relTableForDay(day)
	if _, ok := s.unpacked[day]; ok {
		s.unpacked[day] = time.Now().UnixMilli()
		return rel
	}
	if !s.frozen[day] && !s.coldExists(day) {
		return ""
	}
	glob := q(filepath.Join(s.coldBase, "day="+day, "data.parquet"))
	if _, err := s.db.Exec(fmt.Sprintf("CREATE TEMP TABLE IF NOT EXISTS %s AS SELECT * FROM read_parquet(%s)", rel, glob)); err != nil {
		return ""
	}
	s.unpacked[day] = time.Now().UnixMilli()
	return rel
}

func (s *Store) spanSource(fromMs, toMs int64) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rels []string
	seen := map[string]bool{}
	for _, day := range daysBetween(fromMs, toMs, s.cfg.RetentionDays+1) {
		rel := s.ensureUnpackedLocked(day)
		if rel != "" && !seen[rel] {
			rels = append(rels, rel)
			seen[rel] = true
		}
	}
	if len(rels) == 0 {
		return ""
	}
	if len(rels) == 1 {
		return rels[0]
	}
	parts := make([]string, len(rels))
	for i, r := range rels {
		parts[i] = "SELECT * FROM " + r
	}
	return "(" + strings.Join(parts, " UNION ALL ") + ")"
}

func timeWhere(fromMs, toMs int64) string {
	return fmt.Sprintf("start_ns >= %d AND start_ns <= %d", fromMs*1000000, toMs*1000000)
}

// ---- generic dynamic query ----

func (s *Store) queryAll(query string) ([]map[string]any, error) {
	rows, err := s.db.Query(query)
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
			m[c] = normVal(vals[i])
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func normVal(v any) any {
	switch t := v.(type) {
	case []byte:
		return string(t)
	default:
		return v
	}
}

// ---- rollups ----

func (s *Store) getRollups(fromMs, toMs int64, service, name string) ([]RollupRow, error) {
	hourFrom := (fromMs / 3600000) * 3600000
	var filt []string
	if service != "" {
		filt = append(filt, "service="+q(service))
	}
	if name != "" {
		filt = append(filt, "name="+q(name))
	}
	filtSQL := ""
	if len(filt) > 0 {
		filtSQL = " AND " + strings.Join(filt, " AND ")
	}
	stored := fmt.Sprintf(`SELECT hour_ms, service, name, span_type, is_transaction, dependency, n, errors, sum_dur_ns,
		buckets::VARCHAR AS buckets, counts::VARCHAR AS counts FROM rollups WHERE hour_ms >= %d AND hour_ms <= %d%s`, hourFrom, toMs, filtSQL)
	out, err := s.scanRollups(stored)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	curStart := dayStartMs(time.Now().UnixMilli())
	_ = curStart
	curDayStart, _ := time.Parse("2006-01-02", s.currentDay)
	s.mu.Unlock()
	if toMs >= curDayStart.UnixMilli() {
		liveFilt := ""
		if len(filt) > 0 {
			liveFilt = " WHERE " + strings.Join(filt, " AND ")
		}
		live, err := s.scanRollups(fmt.Sprintf("SELECT * FROM (%s)%s", s.rollupSelect("spans", &hourFrom), liveFilt))
		if err != nil {
			fmt.Fprintln(os.Stderr, "live rollup:", err)
		} else {
			out = append(out, live...)
		}
	}
	return out, nil
}

func (s *Store) scanRollups(query string) ([]RollupRow, error) {
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []RollupRow
	for rows.Next() {
		var r RollupRow
		var dep sql.NullString
		var buckets, counts string
		if err := rows.Scan(&r.HourMs, &r.Service, &r.Name, &r.SpanType, &r.IsTransaction, &dep, &r.N, &r.Errors, &r.SumDurNs, &buckets, &counts); err != nil {
			return nil, err
		}
		r.Dependency = dep.String
		json.Unmarshal([]byte(buckets), &r.Buckets)
		json.Unmarshal([]byte(counts), &r.Counts)
		out = append(out, r)
	}
	return out, rows.Err()
}

// ---- raw queries (traces, export, endpoint detail, dependency detail) ----

func (s *Store) getTraceList(fromMs, toMs int64, service, name, status string, minDur, maxDur float64, limit int) ([]map[string]any, error) {
	src := s.spanSource(fromMs, toMs)
	if src == "" {
		return []map[string]any{}, nil
	}
	w := []string{"is_transaction", timeWhere(fromMs, toMs)}
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
		start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms FROM %s WHERE %s ORDER BY start_ns DESC LIMIT %d`,
		src, strings.Join(w, " AND "), limit))
}

func (s *Store) getTrace(traceID string, dayHintMs int64) ([]map[string]any, error) {
	var search []string
	if dayHintMs > 0 {
		search = daysBetween(dayHintMs-86400000, dayHintMs+86400000, 3)
	} else {
		now := time.Now().UnixMilli()
		d := daysBetween(now-int64(s.cfg.RetentionDays)*86400000, now, s.cfg.RetentionDays+1)
		for i := len(d) - 1; i >= 0; i-- {
			search = append(search, d[i])
		}
	}
	for _, day := range search {
		s.mu.Lock()
		rel := s.ensureUnpackedLocked(day)
		s.mu.Unlock()
		if rel == "" {
			continue
		}
		rows, err := s.queryAll(fmt.Sprintf(`SELECT trace_id, span_id, parent_id, service, name, kind, span_type, dependency,
			is_transaction, status, status_message, http_method, http_status, db_system, db_statement, db_rows,
			start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms, attrs FROM %s WHERE trace_id=%s ORDER BY start_ns`, rel, q(traceID)))
		if err == nil && len(rows) > 0 {
			return rows, nil
		}
	}
	return []map[string]any{}, nil
}

func (s *Store) getDependencyTraces(dep string, fromMs, toMs int64, limit int) ([]map[string]any, error) {
	src := s.spanSource(fromMs, toMs)
	if src == "" {
		return []map[string]any{}, nil
	}
	return s.queryAll(fmt.Sprintf(`SELECT trace_id, span_id, service, name, dependency, span_type, status,
		db_statement, db_rows, start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms FROM %s
		WHERE dependency=%s AND start_ns >= %d ORDER BY start_ns DESC LIMIT %d`, src, q(dep), fromMs*1e6, limit))
}

func (s *Store) getEndpointSummary(service, name string, fromMs, toMs int64) (map[string]any, error) {
	src := s.spanSource(fromMs, toMs)
	if src == "" {
		return map[string]any{}, nil
	}
	rows, err := s.queryAll(fmt.Sprintf(`SELECT count(*)::BIGINT AS n, sum(CASE WHEN status='ERROR' THEN 1 ELSE 0 END)::BIGINT AS errors,
		quantile_cont(dur_ns,0.5)/1e6 AS p50, quantile_cont(dur_ns,0.9)/1e6 AS p90, quantile_cont(dur_ns,0.95)/1e6 AS p95,
		quantile_cont(dur_ns,0.99)/1e6 AS p99, avg(dur_ns)/1e6 AS avg, min(dur_ns)/1e6 AS min, max(dur_ns)/1e6 AS max
		FROM %s WHERE is_transaction AND service=%s AND name=%s AND %s`, src, q(service), q(name), timeWhere(fromMs, toMs)))
	if err != nil || len(rows) == 0 {
		return map[string]any{}, err
	}
	return rows[0], nil
}

func (s *Store) getEndpointBreakdown(service, name string, fromMs, toMs int64) ([]map[string]any, error) {
	src := s.spanSource(fromMs, toMs)
	if src == "" {
		return []map[string]any{}, nil
	}
	return s.queryAll(fmt.Sprintf(`WITH txn AS (SELECT DISTINCT trace_id FROM %s WHERE is_transaction AND service=%s AND name=%s AND %s ORDER BY trace_id LIMIT 300)
		SELECT span_type, count(*) AS n, sum(dur_ns)/1e6 AS ms FROM %s WHERE trace_id IN (SELECT trace_id FROM txn) GROUP BY span_type ORDER BY ms DESC`,
		src, q(service), q(name), timeWhere(fromMs, toMs), src))
}

func (s *Store) getDependencyEndpoints(dep string, fromMs, toMs int64) ([]map[string]any, error) {
	src := s.spanSource(fromMs, toMs)
	if src == "" {
		return []map[string]any{}, nil
	}
	return s.queryAll(fmt.Sprintf(`WITH dep AS (SELECT DISTINCT trace_id FROM %s WHERE dependency=%s AND %s LIMIT 500)
		SELECT service, name, count(*) AS n, avg(dur_ns)/1e6 AS avg_ms FROM %s WHERE is_transaction AND trace_id IN (SELECT trace_id FROM dep)
		GROUP BY service, name ORDER BY n DESC LIMIT 20`, src, q(dep), timeWhere(fromMs, toMs), src))
}

func (s *Store) exportSpans(fromMs, toMs int64, service, name, dep, status string, minDur float64, limit int) ([]map[string]any, error) {
	src := s.spanSource(fromMs, toMs)
	if src == "" {
		return []map[string]any{}, nil
	}
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
		FROM %s WHERE %s ORDER BY start_ns DESC LIMIT %d`, src, strings.Join(w, " AND "), limit))
}

var deniedRe = regexp.MustCompile(`(?i)\b(insert|update|delete|drop|create|alter|attach|copy|install|load|pragma|export|import|call)\b`)

func (s *Store) runReadOnlySQL(query string) (map[string]any, error) {
	trimmed := strings.TrimRight(strings.TrimSpace(query), "; \n\t")
	low := strings.ToLower(trimmed)
	if !(strings.HasPrefix(low, "select") || strings.HasPrefix(low, "with") || strings.HasPrefix(low, "pivot") || strings.HasPrefix(low, "summarize")) {
		return nil, fmt.Errorf("only read-only SELECT/WITH queries are allowed")
	}
	// Word-boundary match so identifiers like `calls` or `created_at` don't trip `call`/`create`.
	if m := deniedRe.FindString(low); m != "" {
		return nil, fmt.Errorf("query contains a disallowed keyword: %s", m)
	}
	now := time.Now().UnixMilli()
	src := s.spanSource(now-int64(s.cfg.RetentionDays)*86400000, now)
	if src == "" || src == "spans" {
		src = "main.spans" // avoid a circular CTE reference when src is the physical table
	}
	suffix := " LIMIT 5000"
	if regexp.MustCompile(`(?i)\blimit\s+\d+\s*$`).MatchString(trimmed) {
		suffix = "" // caller already bounded the result
	}
	wrapped := fmt.Sprintf("WITH spans AS (SELECT * FROM %s) %s%s", src, trimmed, suffix)
	rows, err := s.db.Query(wrapped)
	if err != nil {
		return nil, err
	}
	cols, _ := rows.Columns()
	rows.Close()
	data, err := s.queryAll(wrapped)
	if err != nil {
		return nil, err
	}
	if data == nil {
		data = []map[string]any{}
	}
	return map[string]any{"columns": cols, "rows": data}, nil
}

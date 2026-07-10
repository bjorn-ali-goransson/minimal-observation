package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// Store — SQLite for raw spans (trace lookup, filtered scans, custom SQL) + in-process
// rollups (mergeable histograms) for the overview/chart/percentile screens. The rollups
// need no engine at all, so SQLite only carries the ad-hoc-SQL + retention weight.
//
// No cold tier by design: SQLite's small page cache keeps RSS flat as data grows, so a single
// retention-swept file (DELETE + incremental vacuum) is enough. Overview percentiles are
// histogram-approximate; endpoint-detail percentiles are exact (computed in Go).
type Store struct {
	cfg        Config
	db         *sql.DB
	mu         sync.Mutex
	buffer     []Span
	currentDay string

	rmu     sync.Mutex
	rollups map[rollupKey]*rollupAgg

	frozen     FrozenStore
	fmu        sync.Mutex
	frozenDays map[string]bool
	attached   map[string]int64 // day -> lastAccess unix ms (attached frozen SQLite files)
	loading    map[string]bool  // day -> a fetch (possibly from S3) is in flight
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
		"PRAGMA auto_vacuum=INCREMENTAL",                    // reclaim pages after retention DELETEs (must precede table creation)
		"PRAGMA journal_mode=WAL", "PRAGMA synchronous=OFF", // loss is acceptable by design
		"PRAGMA cache_size=-2000", // ~2MB page cache — deliberately small; keeps RSS flat as data grows
		"PRAGMA temp_store=MEMORY", "PRAGMA busy_timeout=5000",
	} {
		if _, err := db.Exec(p); err != nil {
			return nil, err
		}
	}
	if _, err := db.Exec(createSQL); err != nil {
		return nil, err
	}
	s := &Store{cfg: cfg, db: db, currentDay: today(), rollups: map[rollupKey]*rollupAgg{},
		frozenDays: map[string]bool{}, attached: map[string]int64{}, loading: map[string]bool{}}
	if s.frozen, err = newFrozenStore(cfg); err != nil {
		return nil, err
	}
	if err := s.rebuildRollups(); err != nil { // hot (unfrozen) rollups from the live table
		return nil, err
	}
	if err := s.loadFrozenRollups(); err != nil { // frozen-day rollups from their snapshots
		return nil, err
	}
	go s.loops()
	return s, nil
}

func attachSchema(day string) string { return "f_" + strings.ReplaceAll(day, "-", "_") }

// dayBoundsNs returns [start, end) epoch-nanoseconds for a local calendar day.
func dayBoundsNs(day string) (int64, int64) {
	t, err := time.ParseInLocation("2006-01-02", day, time.Local)
	if err != nil {
		return 0, 0
	}
	start := t.UnixMilli()
	end := t.AddDate(0, 0, 1).UnixMilli()
	return start * 1e6, end * 1e6
}

// loadFrozenRollups pulls each frozen day's small rollup snapshot into the in-memory map,
// so overviews work across restarts without touching the big frozen span files.
func (s *Store) loadFrozenRollups() error {
	days, err := s.frozen.ListDays()
	if err != nil {
		return err
	}
	s.fmu.Lock()
	for _, d := range days {
		s.frozenDays[d] = true
	}
	s.fmu.Unlock()
	for _, d := range days {
		data, err := s.frozen.GetRollups(d)
		if err != nil {
			continue
		}
		var rows []frozenRollup
		if json.Unmarshal(data, &rows) != nil {
			continue
		}
		s.rmu.Lock()
		for _, r := range rows {
			k := rollupKey{Hour: r.Hour, Service: r.Service, Name: r.Name, SpanType: r.SpanType, Dependency: r.Dependency, IsTx: r.IsTx}
			a := s.rollups[k]
			if a == nil {
				a = &rollupAgg{Hist: make([]int, bucketCount)}
				s.rollups[k] = a
			}
			a.N += r.N
			a.Errors += r.Errors
			a.SumDurNs += r.SumDurNs
			for i := 0; i < bucketCount && i < len(r.Hist); i++ {
				a.Hist[i] += r.Hist[i]
			}
		}
		s.rmu.Unlock()
	}
	return nil
}

type frozenRollup struct {
	Hour       int64   `json:"h"`
	Service    string  `json:"s"`
	Name       string  `json:"n"`
	SpanType   string  `json:"t"`
	Dependency string  `json:"d"`
	IsTx       bool    `json:"x"`
	N          int64   `json:"c"`
	Errors     int64   `json:"e"`
	SumDurNs   float64 `json:"m"`
	Hist       []int   `json:"b"`
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

// ---- raw source (hot + attached frozen days) ----

// rawSource returns a relation covering [fromMs,toMs]: the hot `spans` table UNION each frozen
// day in range (attached from its per-day SQLite file, downloaded from S3 on first touch).
// Frozen rows were deleted from hot on freeze, so there is no double counting.
func (s *Store) rawSource(fromMs, toMs int64) string {
	s.fmu.Lock()
	defer s.fmu.Unlock()
	parts := []string{"SELECT * FROM main.spans"}
	for _, day := range daysBetween(fromMs, toMs, s.cfg.RetentionDays+2) {
		if s.frozenDays[day] && s.ensureAttachedLocked(day) {
			parts = append(parts, "SELECT * FROM "+attachSchema(day)+".spans")
		}
	}
	if len(parts) == 1 {
		return "spans"
	}
	return "(" + strings.Join(parts, " UNION ALL ") + ")"
}

// frozenStatus reports the cold tier state for the UI (which days are frozen / currently loaded).
func (s *Store) frozenStatus() map[string]any {
	s.fmu.Lock()
	defer s.fmu.Unlock()
	days := make([]map[string]any, 0, len(s.frozenDays))
	for day := range s.frozenDays {
		last, loaded := s.attached[day]
		days = append(days, map[string]any{"day": day, "loaded": loaded, "loadingNow": s.loading[day], "lastAccessMs": last})
	}
	sort.Slice(days, func(i, j int) bool { return days[i]["day"].(string) > days[j]["day"].(string) })
	loadingNow := false
	for _, v := range s.loading {
		loadingNow = loadingNow || v
	}
	return map[string]any{"coldKind": s.cfg.ColdKind, "retentionDays": s.cfg.RetentionDays, "idleMs": s.cfg.ColdIdleMs, "loadingNow": loadingNow, "days": days}
}

// coldDaysInRange lists frozen days intersecting [fromMs,toMs] — so a handler can tell the UI
// (via a response header) that a request read from cold/S3 storage.
func (s *Store) coldDaysInRange(fromMs, toMs int64) []string {
	s.fmu.Lock()
	defer s.fmu.Unlock()
	var out []string
	for _, day := range daysBetween(fromMs, toMs, s.cfg.RetentionDays+2) {
		if s.frozenDays[day] {
			out = append(out, day)
		}
	}
	return out
}

func (s *Store) ensureAttachedLocked(day string) bool {
	if _, ok := s.attached[day]; ok {
		s.attached[day] = time.Now().UnixMilli()
		return true
	}
	s.loading[day] = true // reflected in /api/frozen while the (possibly S3) fetch is in flight
	defer delete(s.loading, day)
	path, err := s.frozen.EnsureLocal(day)
	if err != nil {
		fmt.Fprintln(os.Stderr, "frozen ensure-local:", day, err)
		return false
	}
	if _, err := s.db.Exec(fmt.Sprintf("ATTACH DATABASE %s AS %s", q(path), attachSchema(day))); err != nil {
		fmt.Fprintln(os.Stderr, "frozen attach:", day, err)
		return false
	}
	s.attached[day] = time.Now().UnixMilli()
	return true
}

func daysBetween(fromMs, toMs int64, maxDays int) []string {
	var days []string
	cur := time.UnixMilli(fromMs)
	cur = time.Date(cur.Year(), cur.Month(), cur.Day(), 0, 0, 0, 0, time.Local)
	end := time.UnixMilli(toMs)
	for !cur.After(end) && len(days) < maxDays {
		days = append(days, cur.Format("2006-01-02"))
		cur = cur.AddDate(0, 0, 1)
	}
	return days
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
		start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms FROM %s WHERE %s ORDER BY start_ns DESC LIMIT %d`,
		s.rawSource(fromMs, toMs), strings.Join(w, " AND "), limit))
}

func (s *Store) getTrace(traceID string, dayHintMs int64) ([]map[string]any, error) {
	from, to := dayHintMs-dayMs, dayHintMs+dayMs
	if dayHintMs == 0 {
		to = time.Now().UnixMilli()
		from = to - int64(s.cfg.RetentionDays)*dayMs
	}
	return s.queryAll(fmt.Sprintf(`SELECT trace_id, span_id, parent_id, service, name, kind, span_type, dependency,
		is_transaction, status, status_message, http_method, http_status, db_system, db_statement, db_rows,
		start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms, attrs FROM %s WHERE trace_id=%s ORDER BY start_ns`,
		s.rawSource(from, to), q(traceID)))
}

func (s *Store) getDependencyTraces(dep string, fromMs, toMs int64, limit int) ([]map[string]any, error) {
	return s.queryAll(fmt.Sprintf(`SELECT trace_id, span_id, service, name, dependency, span_type, status,
		db_statement, db_rows, start_ns/1e6 AS start_ms, dur_ns/1e6 AS dur_ms FROM %s
		WHERE dependency=%s AND start_ns >= %d ORDER BY start_ns DESC LIMIT %d`, s.rawSource(fromMs, toMs), q(dep), fromMs*1e6, limit))
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
	rows, err := s.db.Query(fmt.Sprintf(`SELECT dur_ns, status FROM %s
		WHERE is_transaction=1 AND service=%s AND name=%s AND %s ORDER BY dur_ns LIMIT 200000`,
		s.rawSource(fromMs, toMs), q(service), q(name), timeWhere(fromMs, toMs)))
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
	src := s.rawSource(fromMs, toMs)
	return s.queryAll(fmt.Sprintf(`WITH src AS (SELECT * FROM %s), txn AS (SELECT DISTINCT trace_id FROM src
		WHERE is_transaction=1 AND service=%s AND name=%s AND %s LIMIT 300)
		SELECT span_type, count(*) AS n, sum(dur_ns)/1e6 AS ms FROM src
		WHERE trace_id IN (SELECT trace_id FROM txn) GROUP BY span_type ORDER BY ms DESC`,
		src, q(service), q(name), timeWhere(fromMs, toMs)))
}

func (s *Store) getDependencyEndpoints(dep string, fromMs, toMs int64) ([]map[string]any, error) {
	src := s.rawSource(fromMs, toMs)
	return s.queryAll(fmt.Sprintf(`WITH src AS (SELECT * FROM %s), d AS (SELECT DISTINCT trace_id FROM src WHERE dependency=%s AND %s LIMIT 500)
		SELECT service, name, count(*) AS n, avg(dur_ns)/1e6 AS avg_ms FROM src
		WHERE is_transaction=1 AND trace_id IN (SELECT trace_id FROM d)
		GROUP BY service, name ORDER BY n DESC LIMIT 20`, src, q(dep), timeWhere(fromMs, toMs)))
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
		FROM %s WHERE %s ORDER BY start_ns DESC LIMIT %d`, s.rawSource(fromMs, toMs), strings.Join(w, " AND "), limit))
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
	// Expose `spans` as the full retention window (hot + frozen), not just the hot table.
	now := time.Now().UnixMilli()
	src := s.rawSource(now-int64(s.cfg.RetentionDays)*dayMs, now)
	if src == "spans" {
		src = "(SELECT * FROM main.spans)" // avoid a circular CTE reference
	}
	wrapped := fmt.Sprintf("WITH spans AS %s %s%s", src, trimmed, suffix)
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
	day := s.currentDay
	s.mu.Unlock()
	s.freezeDay(day)
	return day
}

// freezeDay extracts a local day's hot spans into a per-day SQLite file, ships it to the frozen
// store (+ a small rollups snapshot), then deletes those rows from the hot table.
func (s *Store) freezeDay(day string) {
	startNs, endNs := dayBoundsNs(day)
	if startNs == 0 {
		return
	}
	var cnt int64
	s.db.QueryRow(fmt.Sprintf("SELECT count(*) FROM main.spans WHERE start_ns>=%d AND start_ns<%d", startNs, endNs)).Scan(&cnt)
	if cnt == 0 {
		return
	}
	tmp := filepath.Join(s.cfg.DataDir, "freeze-"+attachSchema(day)+".sqlite")
	os.Remove(tmp)
	if _, err := s.db.Exec(fmt.Sprintf("ATTACH DATABASE %s AS fz", q(tmp))); err != nil {
		fmt.Fprintln(os.Stderr, "freeze attach:", err)
		return
	}
	_, err := s.db.Exec(fmt.Sprintf("CREATE TABLE fz.spans AS SELECT * FROM main.spans WHERE start_ns>=%d AND start_ns<%d", startNs, endNs))
	s.db.Exec("DETACH fz")
	if err != nil {
		fmt.Fprintln(os.Stderr, "freeze copy:", err)
		os.Remove(tmp)
		return
	}
	if err := s.frozen.PutDayFile(day, tmp); err != nil {
		fmt.Fprintln(os.Stderr, "freeze put:", err)
		os.Remove(tmp)
		return
	}
	os.Remove(tmp) // no-op for local (moved); removes the temp for s3 (uploaded)
	if snap, err := json.Marshal(s.snapshotDayRollups(startNs/1e6, endNs/1e6)); err == nil {
		s.frozen.PutRollups(day, snap)
	}
	s.db.Exec(fmt.Sprintf("DELETE FROM main.spans WHERE start_ns>=%d AND start_ns<%d", startNs, endNs))
	s.db.Exec("PRAGMA incremental_vacuum")
	s.fmu.Lock()
	s.frozenDays[day] = true
	s.fmu.Unlock()
}

func (s *Store) snapshotDayRollups(startMs, endMs int64) []frozenRollup {
	s.rmu.Lock()
	defer s.rmu.Unlock()
	var out []frozenRollup
	for k, a := range s.rollups {
		if k.Hour >= startMs && k.Hour < endMs {
			hist := make([]int, bucketCount)
			copy(hist, a.Hist)
			out = append(out, frozenRollup{Hour: k.Hour, Service: k.Service, Name: k.Name, SpanType: k.SpanType,
				Dependency: k.Dependency, IsTx: k.IsTx, N: a.N, Errors: a.Errors, SumDurNs: a.SumDurNs, Hist: hist})
		}
	}
	return out
}

func (s *Store) maintenance() {
	// Roll over: freeze any local day that is fully in the past and still sitting in hot.
	yesterday := dayOf(time.Now().UnixMilli() - dayMs)
	s.fmu.Lock()
	needFreeze := !s.frozenDays[yesterday] && yesterday != s.currentDay
	s.fmu.Unlock()
	if needFreeze {
		s.freezeDay(yesterday)
	}

	cutoffMs := time.Now().UnixMilli() - int64(s.cfg.RetentionDays)*86400000
	cutoffDay := dayOf(cutoffMs)
	s.db.Exec(fmt.Sprintf("DELETE FROM spans WHERE start_ns < %d", cutoffMs*1000000))
	s.db.Exec("PRAGMA incremental_vacuum")
	s.rmu.Lock()
	for k := range s.rollups {
		if k.Hour < cutoffMs {
			delete(s.rollups, k)
		}
	}
	s.rmu.Unlock()

	// Evict idle attached frozen days; drop frozen days past retention.
	s.fmu.Lock()
	now := time.Now().UnixMilli()
	for day, last := range s.attached {
		if now-last > int64(s.cfg.ColdIdleMs) {
			s.db.Exec("DETACH " + attachSchema(day))
			delete(s.attached, day)
		}
	}
	var drop []string
	for day := range s.frozenDays {
		if day < cutoffDay {
			drop = append(drop, day)
		}
	}
	s.fmu.Unlock()
	for _, day := range drop {
		s.frozen.Drop(day)
		s.fmu.Lock()
		if _, ok := s.attached[day]; ok {
			s.db.Exec("DETACH " + attachSchema(day))
			delete(s.attached, day)
		}
		delete(s.frozenDays, day)
		s.fmu.Unlock()
	}
}

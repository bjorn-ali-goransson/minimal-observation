package main

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strconv"
	"strings"
)

// Span is the one canonical row shape (port of packages/shared/span.ts).
type Span struct {
	TraceID        string
	SpanID         string
	ParentID       *string
	Service        string
	ServiceVersion *string
	Environment    *string
	Name           string
	Kind           string
	IsTransaction  bool
	SpanType       string
	Dependency     *string
	StartNs        int64
	EndNs          int64
	DurNs          int64
	Status         string
	StatusMessage  *string
	HTTPMethod     *string
	HTTPStatus     *int64
	DBSystem       *string
	DBStatement    *string
	DBRows         int64
	Attrs          map[string]any
}

// spanColumns is the exact appender order.
var spanColumns = []string{
	"trace_id", "span_id", "parent_id", "service", "service_version", "environment",
	"name", "kind", "is_transaction", "span_type", "dependency", "start_ns", "end_ns",
	"dur_ns", "status", "status_message", "http_method", "http_status", "db_system",
	"db_statement", "db_rows", "attrs",
}

const createSpansTable = `CREATE TABLE IF NOT EXISTS spans (
  trace_id VARCHAR, span_id VARCHAR, parent_id VARCHAR, service VARCHAR, service_version VARCHAR,
  environment VARCHAR, name VARCHAR, kind VARCHAR, is_transaction BOOLEAN, span_type VARCHAR,
  dependency VARCHAR, start_ns BIGINT, end_ns BIGINT, dur_ns BIGINT, status VARCHAR,
  status_message VARCHAR, http_method VARCHAR, http_status INTEGER, db_system VARCHAR,
  db_statement VARCHAR, db_rows BIGINT, attrs JSON)`

type otlpVal struct {
	StringValue *string      `json:"stringValue"`
	IntValue    *json.Number `json:"intValue"`
	DoubleValue *float64     `json:"doubleValue"`
	BoolValue   *bool        `json:"boolValue"`
	ArrayValue  *struct {
		Values []otlpVal `json:"values"`
	} `json:"arrayValue"`
	KvlistValue *struct {
		Values []otlpKV `json:"values"`
	} `json:"kvlistValue"`
}
type otlpKV struct {
	Key   string   `json:"key"`
	Value *otlpVal `json:"value"`
}
type otlpSpan struct {
	TraceID           string      `json:"traceId"`
	SpanID            string      `json:"spanId"`
	ParentSpanID      string      `json:"parentSpanId"`
	Name              string      `json:"name"`
	Kind              int         `json:"kind"`
	StartTimeUnixNano json.Number `json:"startTimeUnixNano"`
	EndTimeUnixNano   json.Number `json:"endTimeUnixNano"`
	Attributes        []otlpKV    `json:"attributes"`
	Status            struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"status"`
}
type otlpExport struct {
	ResourceSpans []struct {
		Resource struct {
			Attributes []otlpKV `json:"attributes"`
		} `json:"resource"`
		ScopeSpans []struct {
			Spans []otlpSpan `json:"spans"`
		} `json:"scopeSpans"`
		InstrumentationLibrarySpans []struct {
			Spans []otlpSpan `json:"spans"`
		} `json:"instrumentationLibrarySpans"`
	} `json:"resourceSpans"`
}

func (v *otlpVal) val() any {
	if v == nil {
		return nil
	}
	switch {
	case v.StringValue != nil:
		return *v.StringValue
	case v.IntValue != nil:
		n, _ := v.IntValue.Int64()
		return n
	case v.DoubleValue != nil:
		return *v.DoubleValue
	case v.BoolValue != nil:
		return *v.BoolValue
	case v.ArrayValue != nil:
		out := make([]any, 0, len(v.ArrayValue.Values))
		for i := range v.ArrayValue.Values {
			out = append(out, v.ArrayValue.Values[i].val())
		}
		return out
	case v.KvlistValue != nil:
		return attrsToObject(v.KvlistValue.Values)
	}
	return nil
}

func attrsToObject(kvs []otlpKV) map[string]any {
	out := map[string]any{}
	for i := range kvs {
		if kvs[i].Key != "" {
			out[kvs[i].Key] = kvs[i].Value.val()
		}
	}
	return out
}

var hexRe = regexp.MustCompile(`^[0-9a-fA-F]+$`)

func normID(id string) string {
	if id == "" {
		return ""
	}
	if hexRe.MatchString(id) && (len(id) == 32 || len(id) == 16) {
		return strings.ToLower(id)
	}
	if b, err := base64.StdEncoding.DecodeString(id); err == nil {
		return hex.EncodeToString(b)
	}
	return id
}

var kindNames = []string{"INTERNAL", "INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"}

func pick(a map[string]any, keys ...string) any {
	for _, k := range keys {
		if v, ok := a[k]; ok && v != nil {
			return v
		}
	}
	return nil
}
func sptr(x any) *string {
	if x == nil {
		return nil
	}
	s := toStr(x)
	return &s
}
func toStr(x any) string {
	switch v := x.(type) {
	case string:
		return v
	case int64:
		return strconv.FormatInt(v, 10)
	case float64:
		return strconv.FormatFloat(v, 'g', -1, 64)
	case bool:
		if v {
			return "true"
		}
		return "false"
	}
	b, _ := json.Marshal(x)
	return string(b)
}
func nptr(x any) *int64 {
	switch v := x.(type) {
	case int64:
		return &v
	case float64:
		n := int64(v)
		return &n
	case string:
		if n, err := json.Number(v).Int64(); err == nil {
			return &n
		}
	}
	return nil
}

func classify(kind string, a map[string]any, name string) string {
	if a["db.system"] != nil {
		return "db"
	}
	if a["messaging.system"] != nil {
		return "messaging"
	}
	if strings.HasPrefix(name, "fs ") || a["fs.operation"] != nil {
		return "fs"
	}
	hasHTTP := pick(a, "http.request.method", "http.method", "url.full", "url.path", "rpc.system") != nil
	if kind == "SERVER" || kind == "CONSUMER" {
		if hasHTTP {
			return "http"
		}
		return "internal"
	}
	if kind == "CLIENT" || kind == "PRODUCER" {
		if hasHTTP {
			return "external"
		}
	}
	return "internal"
}

func depName(t string, a map[string]any, name string) *string {
	switch t {
	case "db":
		sys := "db"
		if s := pick(a, "db.system"); s != nil {
			sys = toStr(s)
		}
		if db := pick(a, "db.name", "db.namespace"); db != nil {
			s := sys + ":" + toStr(db)
			return &s
		}
		return &sys
	case "messaging":
		sys := "queue"
		if s := pick(a, "messaging.system"); s != nil {
			sys = toStr(s)
		}
		if d := pick(a, "messaging.destination.name", "messaging.destination"); d != nil {
			s := sys + ":" + toStr(d)
			return &s
		}
		return &sys
	case "external":
		method := pick(a, "http.request.method", "http.method")
		host := pick(a, "server.address", "net.peer.name", "url.host", "peer.service")
		if host != nil {
			s := toStr(host)
			if method != nil {
				s = toStr(method) + " " + s
			}
			return &s
		}
		return &name
	case "fs":
		s := "filesystem"
		return &s
	}
	return nil
}

func parseOtlpTraces(body []byte) ([]Span, error) {
	var root otlpExport
	if err := json.Unmarshal(body, &root); err != nil {
		return nil, err
	}
	var spans []Span
	for _, rs := range root.ResourceSpans {
		ra := attrsToObject(rs.Resource.Attributes)
		service := "unknown"
		if s := pick(ra, "service.name"); s != nil {
			service = toStr(s)
		}
		sv := sptr(pick(ra, "service.version"))
		envn := sptr(pick(ra, "deployment.environment.name", "deployment.environment"))
		scopes := rs.ScopeSpans
		if len(scopes) == 0 {
			for _, il := range rs.InstrumentationLibrarySpans {
				scopes = append(scopes, struct {
					Spans []otlpSpan `json:"spans"`
				}{Spans: il.Spans})
			}
		}
		for _, ss := range scopes {
			for _, s := range ss.Spans {
				a := attrsToObject(s.Attributes)
				kind := "INTERNAL"
				if s.Kind >= 0 && s.Kind < len(kindNames) {
					kind = kindNames[s.Kind]
				}
				startNs, _ := s.StartTimeUnixNano.Int64()
				endNs, _ := s.EndTimeUnixNano.Int64()
				dur := int64(0)
				if endNs > startNs {
					dur = endNs - startNs
				}
				spanType := classify(kind, a, s.Name)
				httpStatus := nptr(pick(a, "http.response.status_code", "http.status_code"))
				status := "UNSET"
				switch s.Status.Code {
				case 2:
					status = "ERROR"
				case 1:
					status = "OK"
				}
				if status != "ERROR" && httpStatus != nil && *httpStatus >= 500 {
					status = "ERROR"
				}
				var parent *string
				if s.ParentSpanID != "" {
					p := normID(s.ParentSpanID)
					parent = &p
				}
				var dep *string
				if kind == "CLIENT" || kind == "PRODUCER" {
					dep = depName(spanType, a, s.Name)
				}
				dbRows := int64(-1)
				if r := nptr(pick(a, "db.rows_iterated", "db.response.returned_rows", "db.result.rows", "db.rows_affected")); r != nil {
					dbRows = *r
				}
				var statusMsg *string
				if s.Status.Message != "" {
					statusMsg = &s.Status.Message
				}
				spans = append(spans, Span{
					TraceID: normID(s.TraceID), SpanID: normID(s.SpanID), ParentID: parent,
					Service: service, ServiceVersion: sv, Environment: envn, Name: s.Name, Kind: kind,
					IsTransaction: kind == "SERVER" || kind == "CONSUMER", SpanType: spanType, Dependency: dep,
					StartNs: startNs, EndNs: endNs, DurNs: dur, Status: status, StatusMessage: statusMsg,
					HTTPMethod: sptr(pick(a, "http.request.method", "http.method")), HTTPStatus: httpStatus,
					DBSystem: sptr(pick(a, "db.system")), DBStatement: sptr(pick(a, "db.statement", "db.query.text")),
					DBRows: dbRows, Attrs: a,
				})
			}
		}
	}
	return spans, nil
}

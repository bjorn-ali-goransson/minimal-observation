package main

import "sort"

type Agg struct {
	N        int64
	Errors   int64
	SumDurNs float64
	Hist     []float64
}

func histFrom(buckets, counts []int) []float64 {
	h := emptyHistogram()
	for i := 0; i < len(buckets); i++ {
		b := buckets[i]
		if b >= 0 && b < bucketCount && i < len(counts) {
			h[b] += float64(counts[i])
		}
	}
	return h
}

func newAgg() *Agg { return &Agg{Hist: emptyHistogram()} }

func (a *Agg) add(r RollupRow) {
	a.N += r.N
	a.Errors += r.Errors
	a.SumDurNs += r.SumDurNs
	mergeInto(a.Hist, histFrom(r.Buckets, r.Counts))
}

type Summary struct {
	Count            int64   `json:"count"`
	ErrorRate        float64 `json:"errorRate"`
	ThroughputPerMin float64 `json:"throughputPerMin"`
	AvgMs            float64 `json:"avgMs"`
	P50Ms            float64 `json:"p50Ms"`
	P95Ms            float64 `json:"p95Ms"`
	P99Ms            float64 `json:"p99Ms"`
}

func (a *Agg) summarize(windowMs int64) Summary {
	minutes := float64(windowMs) / 60000.0
	if minutes < 1.0/60 {
		minutes = 1.0 / 60
	}
	s := Summary{Count: a.N}
	if a.N > 0 {
		s.ErrorRate = float64(a.Errors) / float64(a.N)
		s.AvgMs = a.SumDurNs / float64(a.N) / 1e6
	}
	s.ThroughputPerMin = float64(a.N) / minutes
	s.P50Ms = percentileFromHistogram(a.Hist, 0.5)
	s.P95Ms = percentileFromHistogram(a.Hist, 0.95)
	s.P99Ms = percentileFromHistogram(a.Hist, 0.99)
	return s
}

// groupSummaries groups rollup rows by key and summarizes each group.
func groupSummaries(rows []RollupRow, keyOf func(RollupRow) (string, bool), windowMs int64) map[string]Summary {
	groups := map[string]*Agg{}
	for _, r := range rows {
		k, ok := keyOf(r)
		if !ok {
			continue
		}
		g := groups[k]
		if g == nil {
			g = newAgg()
			groups[k] = g
		}
		g.add(r)
	}
	out := map[string]Summary{}
	for k, a := range groups {
		out[k] = a.summarize(windowMs)
	}
	return out
}

type Point struct {
	T     int64   `json:"t"`
	Value float64 `json:"value"`
}

func timeseries(rows []RollupRow, metric string) []Point {
	byHour := map[int64]*Agg{}
	for _, r := range rows {
		a := byHour[r.HourMs]
		if a == nil {
			a = newAgg()
			byHour[r.HourMs] = a
		}
		a.add(r)
	}
	var hours []int64
	for h := range byHour {
		hours = append(hours, h)
	}
	sort.Slice(hours, func(i, j int) bool { return hours[i] < hours[j] })
	out := make([]Point, 0, len(hours))
	for _, h := range hours {
		s := byHour[h].summarize(3600000)
		var v float64
		switch metric {
		case "throughput":
			v = s.ThroughputPerMin
		case "errorRate":
			v = s.ErrorRate
		case "avg":
			v = s.AvgMs
		case "p50":
			v = s.P50Ms
		case "p99":
			v = s.P99Ms
		default:
			v = s.P95Ms
		}
		out = append(out, Point{T: h, Value: v})
	}
	return out
}

type BreakdownItem struct {
	Type     string  `json:"type"`
	Ms       float64 `json:"ms"`
	Fraction float64 `json:"fraction"`
}

func breakdownFrom(rows []RollupRow) []BreakdownItem {
	byType := map[string]float64{}
	total := 0.0
	for _, r := range rows {
		byType[r.SpanType] += r.SumDurNs
		total += r.SumDurNs
	}
	if total == 0 {
		total = 1
	}
	out := make([]BreakdownItem, 0, len(byType))
	for t, sum := range byType {
		out = append(out, BreakdownItem{Type: t, Ms: sum / 1e6, Fraction: sum / total})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Ms > out[j].Ms })
	return out
}

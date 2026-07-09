package main

import "math"

// Fixed-boundary latency histograms — mergeable, so multi-day percentiles come from
// small rollups without touching raw cold spans. Port of packages/shared/histogram.ts.

var bucketBoundsMs = func() []float64 {
	var b []float64
	v := 0.25
	for v <= 120000 {
		b = append(b, math.Round(v*1000)/1000)
		v *= 1.5
	}
	b = append(b, math.Inf(1))
	return b
}()

var bucketCount = len(bucketBoundsMs)

func emptyHistogram() []float64 { return make([]float64, bucketCount) }

func mergeInto(target, src []float64) {
	for i := 0; i < bucketCount && i < len(src); i++ {
		target[i] += src[i]
	}
}

func percentileFromHistogram(hist []float64, q float64) float64 {
	total := 0.0
	for _, c := range hist {
		total += c
	}
	if total == 0 {
		return 0
	}
	rank := q * total
	cum := 0.0
	for i := 0; i < bucketCount; i++ {
		c := hist[i]
		if c == 0 {
			continue
		}
		if cum+c >= rank {
			lower := 0.0
			if i > 0 {
				lower = bucketBoundsMs[i-1]
			}
			upper := bucketBoundsMs[i]
			if math.IsInf(upper, 1) {
				upper = lower * 1.5
			}
			frac := (rank - cum) / c
			return lower + (upper-lower)*frac
		}
		cum += c
	}
	if bucketCount >= 2 {
		return bucketBoundsMs[bucketCount-2]
	}
	return 0
}

import { describe, expect, it } from "vitest";

import {
  collectHistogram,
  gauge,
  histogramDelta,
  histogramQuantile,
  parsePrometheusText,
  rate,
  sumOf,
  type HistogramSnapshot,
} from "./prometheus";

/** Shaped exactly like vLLM's /metrics output, including the model label. */
const SAMPLE = `
# HELP vllm:num_requests_running Number of requests in model execution batches.
# TYPE vllm:num_requests_running gauge
vllm:num_requests_running{engine="0",model_name="granite-4.1-8b"} 6.0
vllm:num_requests_waiting{engine="0",model_name="granite-4.1-8b"} 2.0
vllm:kv_cache_usage_perc{engine="0",model_name="granite-4.1-8b"} 0.4213
# TYPE vllm:generation_tokens counter
vllm:generation_tokens_total{engine="0",model_name="granite-4.1-8b"} 128000.0
vllm:prompt_tokens_total{engine="0",model_name="granite-4.1-8b"} 51200.0
# TYPE vllm:time_to_first_token_seconds histogram
vllm:time_to_first_token_seconds_bucket{le="0.01",model_name="granite-4.1-8b"} 0.0
vllm:time_to_first_token_seconds_bucket{le="0.05",model_name="granite-4.1-8b"} 10.0
vllm:time_to_first_token_seconds_bucket{le="0.1",model_name="granite-4.1-8b"} 50.0
vllm:time_to_first_token_seconds_bucket{le="0.5",model_name="granite-4.1-8b"} 90.0
vllm:time_to_first_token_seconds_bucket{le="1.0",model_name="granite-4.1-8b"} 100.0
vllm:time_to_first_token_seconds_bucket{le="+Inf",model_name="granite-4.1-8b"} 100.0
vllm:time_to_first_token_seconds_sum{model_name="granite-4.1-8b"} 12.5
vllm:time_to_first_token_seconds_count{model_name="granite-4.1-8b"} 100.0
`;

describe("parsePrometheusText", () => {
  const metrics = parsePrometheusText(SAMPLE);

  it("skips comments and blank lines", () => {
    expect(metrics.every((m) => !m.name.startsWith("#"))).toBe(true);
  });

  it("reads name, labels and value", () => {
    const m = metrics.find((x) => x.name === "vllm:num_requests_running");
    expect(m?.value).toBe(6);
    expect(m?.labels.model_name).toBe("granite-4.1-8b");
    expect(m?.labels.engine).toBe("0");
  });

  it("parses a metric with no labels", () => {
    const m = parsePrometheusText("python_gc_objects 42.0");
    expect(m[0]).toEqual({ name: "python_gc_objects", labels: {}, value: 42 });
  });

  it("keeps label values containing commas intact", () => {
    const m = parsePrometheusText('x{a="one,two",b="c"} 1');
    expect(m[0].labels.a).toBe("one,two");
    expect(m[0].labels.b).toBe("c");
  });

  it("ignores a trailing timestamp", () => {
    expect(parsePrometheusText("x 5 1700000000000")[0].value).toBe(5);
  });
});

describe("sumOf and gauge", () => {
  const metrics = parsePrometheusText(SAMPLE);

  it("sums a metric across label sets", () => {
    const multi = parsePrometheusText('x{a="1"} 2\nx{a="2"} 3');
    expect(sumOf(multi, "x")).toBe(5);
  });

  it("returns 0 for a metric that is not present", () => {
    expect(sumOf(metrics, "vllm:nonexistent")).toBe(0);
    expect(gauge(metrics, "vllm:nonexistent")).toBe(0);
  });

  it("reads a gauge", () => {
    expect(gauge(metrics, "vllm:kv_cache_usage_perc")).toBeCloseTo(0.4213);
  });
});

describe("collectHistogram", () => {
  const h = collectHistogram(parsePrometheusText(SAMPLE), "vllm:time_to_first_token_seconds");

  it("collects buckets in ascending bound order", () => {
    expect(h.buckets.map((b) => b.le)).toEqual([0.01, 0.05, 0.1, 0.5, 1.0, Infinity]);
  });

  it("reads sum and count", () => {
    expect(h.sum).toBe(12.5);
    expect(h.count).toBe(100);
  });
});

describe("histogramQuantile", () => {
  const h = collectHistogram(parsePrometheusText(SAMPLE), "vllm:time_to_first_token_seconds");

  it("interpolates the median inside its bucket", () => {
    // Cumulative counts: 50 at le=0.1, 90 at le=0.5. The 50th observation sits
    // exactly at the 0.1 boundary.
    expect(histogramQuantile(h, 0.5)).toBeCloseTo(0.1, 6);
  });

  it("interpolates p95 between the 0.5 and 1.0 bounds", () => {
    // target 95 falls between 90 (le=0.5) and 100 (le=1.0): halfway.
    expect(histogramQuantile(h, 0.95)).toBeCloseTo(0.75, 6);
  });

  it("is monotonic across quantiles", () => {
    const p50 = histogramQuantile(h, 0.5)!;
    const p95 = histogramQuantile(h, 0.95)!;
    const p99 = histogramQuantile(h, 0.99)!;
    expect(p50).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(p99);
  });

  it("returns null for an empty histogram", () => {
    expect(histogramQuantile({ buckets: [], sum: 0, count: 0 }, 0.5)).toBeNull();
  });

  it("does not invent a value beyond the last finite bound", () => {
    const overflow: HistogramSnapshot = {
      buckets: [
        { le: 1, count: 5 },
        { le: Infinity, count: 10 },
      ],
      sum: 100,
      count: 10,
    };
    // p99 lands in the +Inf bucket; the honest answer is the last real bound.
    expect(histogramQuantile(overflow, 0.99)).toBe(1);
  });
});

describe("histogramDelta", () => {
  const mk = (counts: number[], count: number, sum: number): HistogramSnapshot => ({
    buckets: [
      { le: 0.1, count: counts[0] },
      { le: 1, count: counts[1] },
      { le: Infinity, count: counts[2] },
    ],
    sum,
    count,
  });

  it("differences cumulative buckets so percentiles describe the recent window", () => {
    const d = histogramDelta(mk([10, 20, 20], 20, 5), mk([12, 30, 30], 30, 9));
    expect(d.buckets.map((b) => b.count)).toEqual([2, 10, 10]);
    expect(d.count).toBe(10);
    expect(d.sum).toBeCloseTo(4);
  });

  it("reports an empty window when nothing new arrived", () => {
    const same = mk([10, 20, 20], 20, 5);
    expect(histogramDelta(same, same).count).toBe(0);
  });

  it("falls back to absolute values after a counter reset", () => {
    // A restarted server reports smaller numbers than the previous scrape.
    const d = histogramDelta(mk([100, 200, 200], 200, 50), mk([1, 2, 2], 2, 0.5));
    expect(d.count).toBe(0);
  });

  it("uses the current snapshot when there is no previous one", () => {
    const now = mk([1, 2, 2], 2, 1);
    expect(histogramDelta(null, now)).toBe(now);
  });
});

describe("rate", () => {
  it("computes per-second rate from a counter delta", () => {
    expect(rate(1000, 2000, 1000)).toBe(1000);
    expect(rate(1000, 1500, 500)).toBe(1000);
  });

  it("returns 0 on the first reading", () => {
    expect(rate(null, 500, 1000)).toBe(0);
  });

  it("returns 0 rather than a negative rate after a counter reset", () => {
    expect(rate(5000, 10, 1000)).toBe(0);
  });

  it("returns 0 when no time has passed", () => {
    expect(rate(0, 100, 0)).toBe(0);
  });
});

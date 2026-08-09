import type { BenchmarkResultRow } from "@/lib/types";

/**
 * Parses GuideLLM's result JSON into flat rows.
 *
 * Written against the real schema emitted by GuideLLM 0.7.3 (`metadata.version`
 * 2), captured from an actual run rather than inferred from docs. The shape is:
 *
 *   { metadata, config, benchmarks: [ {
 *       config: { strategy: { type_, streams|rate|max_concurrency } },
 *       metrics: { <name>: { successful: { mean, percentiles: {p50,p95,p99} } } },
 *       start_time, end_time, duration } ] }
 *
 * Units are mixed and the field names say which: `*_ms` metrics are already in
 * milliseconds, while `request_latency` is in seconds. Getting that wrong would
 * silently misreport end-to-end latency by 1000x, so the conversions are
 * explicit and tested.
 */

interface StatBlock {
  mean?: number;
  median?: number;
  min?: number;
  max?: number;
  count?: number;
  percentiles?: Record<string, number>;
}

interface MetricBlock {
  successful?: StatBlock;
  errored?: StatBlock;
  total?: StatBlock;
}

interface RawBenchmark {
  config?: {
    strategy?: {
      type_?: string;
      streams?: number;
      rate?: number;
      max_concurrency?: number;
    };
  };
  metrics?: Record<string, MetricBlock | RequestTotals | undefined>;
  start_time?: number;
  end_time?: number;
  duration?: number;
}

interface RequestTotals {
  successful?: number;
  errored?: number;
  incomplete?: number;
  total?: number;
}

export interface RawReport {
  metadata?: { guidellm_version?: string; version?: number };
  benchmarks?: RawBenchmark[];
}

const stat = (m: unknown): StatBlock | null => {
  const block = m as MetricBlock | undefined;
  return block?.successful ?? null;
};

const mean = (m: unknown): number | null => {
  const s = stat(m);
  return s?.mean != null && Number.isFinite(s.mean) ? s.mean : null;
};

const pct = (m: unknown, key: string): number | null => {
  const s = stat(m);
  const v = s?.percentiles?.[key];
  return v != null && Number.isFinite(v) ? v : null;
};

const scale = (v: number | null, factor: number): number | null =>
  v == null ? null : v * factor;

/** Requested load level, whichever way this strategy expresses it. */
type Strategy = NonNullable<NonNullable<RawBenchmark["config"]>["strategy"]>;

export function strategyRate(strategy: Strategy | undefined): number | null {
  if (!strategy) return null;
  return strategy.rate ?? strategy.streams ?? strategy.max_concurrency ?? null;
}

export function parseReport(json: unknown): Omit<BenchmarkResultRow, "id" | "runId">[] {
  const report = json as RawReport;
  const benchmarks = report?.benchmarks ?? [];

  return benchmarks.map((b, idx) => {
    const m = b.metrics ?? {};
    const totals = (m.request_totals as RequestTotals | undefined) ?? {};
    const strategy = b.config?.strategy;

    return {
      idx,
      strategy: strategy?.type_ ?? null,
      rate: strategyRate(strategy),
      concurrency: mean(m.request_concurrency),
      // GuideLLM reports epoch seconds as floats; the app works in epoch ms.
      startedAt: b.start_time != null ? Math.round(b.start_time * 1000) : null,
      finishedAt: b.end_time != null ? Math.round(b.end_time * 1000) : null,
      requestsOk: totals.successful ?? null,
      requestsErr: totals.errored ?? null,
      reqPerS: mean(m.requests_per_second),
      outputTokS: mean(m.output_tokens_per_second),
      totalTokS: mean(m.tokens_per_second),

      // Already milliseconds — the field name carries the unit.
      ttftMeanMs: mean(m.time_to_first_token_ms),
      ttftP50Ms: pct(m.time_to_first_token_ms, "p50"),
      ttftP95Ms: pct(m.time_to_first_token_ms, "p95"),
      ttftP99Ms: pct(m.time_to_first_token_ms, "p99"),

      itlMeanMs: mean(m.inter_token_latency_ms),
      itlP50Ms: pct(m.inter_token_latency_ms, "p50"),
      itlP95Ms: pct(m.inter_token_latency_ms, "p95"),
      itlP99Ms: pct(m.inter_token_latency_ms, "p99"),

      // request_latency has no unit suffix and is in seconds.
      e2eMeanMs: scale(mean(m.request_latency), 1000),
      e2eP50Ms: scale(pct(m.request_latency, "p50"), 1000),
      e2eP95Ms: scale(pct(m.request_latency, "p95"), 1000),
      e2eP99Ms: scale(pct(m.request_latency, "p99"), 1000),

      promptTokMean: mean(m.prompt_token_count),
      outputTokMean: mean(m.output_token_count),
    };
  });
}

export function reportVersion(json: unknown): string | null {
  return (json as RawReport)?.metadata?.guidellm_version ?? null;
}

/**
 * Finds the knee of the throughput curve — the load level past which output
 * throughput stops improving. That point is the practical serving capacity,
 * and it is the single number most people run a sweep to discover.
 */
export function findSaturationPoint(
  rows: Array<Pick<BenchmarkResultRow, "concurrency" | "outputTokS" | "rate">>,
): { concurrency: number; outputTokS: number } | null {
  const points = rows
    .map((r) => ({
      concurrency: r.concurrency ?? r.rate ?? 0,
      outputTokS: r.outputTokS ?? 0,
    }))
    .filter((p) => p.concurrency > 0 && p.outputTokS > 0)
    .sort((a, b) => a.concurrency - b.concurrency);

  if (points.length < 3) return null;

  const peak = points.reduce((a, b) => (b.outputTokS > a.outputTokS ? b : a));

  // The knee is the lowest load already within 5% of peak throughput: past it
  // you are paying latency for throughput you are not getting.
  const threshold = peak.outputTokS * 0.95;
  const knee = points.find((p) => p.outputTokS >= threshold) ?? peak;
  return knee;
}

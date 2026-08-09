/**
 * Minimal Prometheus text-exposition parser plus the derivations vLLM's
 * metrics need.
 *
 * vLLM reports latency as histograms and token counts as monotonic counters.
 * Neither is directly displayable: a counter has to be differenced against the
 * previous scrape to become a rate, and a histogram has to be interpolated to
 * become a percentile. Both are done here, in pure functions, so they can be
 * tested without a running server.
 */

export interface Metric {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export function parsePrometheusText(text: string): Metric[] {
  const out: Metric[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    // name{label="v",...} value [timestamp]
    const braceStart = line.indexOf("{");
    let name: string;
    let labels: Record<string, string> = {};
    let rest: string;

    if (braceStart >= 0) {
      const braceEnd = line.lastIndexOf("}");
      if (braceEnd < 0) continue;
      name = line.slice(0, braceStart);
      labels = parseLabels(line.slice(braceStart + 1, braceEnd));
      rest = line.slice(braceEnd + 1).trim();
    } else {
      const sp = line.indexOf(" ");
      if (sp < 0) continue;
      name = line.slice(0, sp);
      rest = line.slice(sp + 1).trim();
    }

    const value = Number.parseFloat(rest.split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    out.push({ name, labels, value });
  }
  return out;
}

function parseLabels(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Values may contain commas and escaped quotes, so scan rather than split.
  const re = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return out;
}

/** Sums a metric across all label sets (vLLM labels everything by model). */
export function sumOf(metrics: Metric[], name: string): number {
  let total = 0;
  for (const m of metrics) if (m.name === name) total += m.value;
  return total;
}

/** Last value of a gauge, ignoring labels. */
export function gauge(metrics: Metric[], name: string): number {
  for (let i = metrics.length - 1; i >= 0; i--) {
    if (metrics[i].name === name) return metrics[i].value;
  }
  return 0;
}

export interface HistogramSnapshot {
  /** Cumulative counts keyed by upper bound, ascending. `+Inf` included. */
  buckets: Array<{ le: number; count: number }>;
  sum: number;
  count: number;
}

/** Collects `<name>_bucket`, `<name>_sum` and `<name>_count` into one shape. */
export function collectHistogram(metrics: Metric[], name: string): HistogramSnapshot {
  const byLe = new Map<number, number>();
  let sum = 0;
  let count = 0;

  for (const m of metrics) {
    if (m.name === `${name}_bucket`) {
      const le = m.labels.le === "+Inf" ? Infinity : Number.parseFloat(m.labels.le);
      if (!Number.isNaN(le)) byLe.set(le, (byLe.get(le) ?? 0) + m.value);
    } else if (m.name === `${name}_sum`) {
      sum += m.value;
    } else if (m.name === `${name}_count`) {
      count += m.value;
    }
  }

  const buckets = [...byLe.entries()]
    .map(([le, c]) => ({ le, count: c }))
    .sort((a, b) => a.le - b.le);

  return { buckets, sum, count };
}

/**
 * Interpolates a quantile out of a cumulative histogram, the same way
 * Prometheus' own `histogram_quantile` does.
 *
 * Counts are *cumulative*: bucket `le=0.5` includes everything below 0.25. The
 * result is linearly interpolated inside the bucket the quantile falls in,
 * which is why a coarse bucket layout gives an approximate answer — the UI
 * labels these as estimates for that reason.
 */
export function histogramQuantile(h: HistogramSnapshot, q: number): number | null {
  if (h.buckets.length === 0 || h.count === 0) return null;
  const total = h.buckets[h.buckets.length - 1].count;
  if (total <= 0) return null;

  const target = q * total;

  let prevLe = 0;
  let prevCount = 0;
  for (const b of h.buckets) {
    if (b.count >= target) {
      if (b.le === Infinity) {
        // Nothing above the last finite bound to interpolate into; the honest
        // answer is that bound rather than a fabricated larger number.
        return prevLe > 0 ? prevLe : null;
      }
      const spanCount = b.count - prevCount;
      if (spanCount <= 0) return b.le;
      const frac = (target - prevCount) / spanCount;
      return prevLe + (b.le - prevLe) * frac;
    }
    prevLe = b.le === Infinity ? prevLe : b.le;
    prevCount = b.count;
  }
  return prevLe > 0 ? prevLe : null;
}

/**
 * Difference between two histogram snapshots, so percentiles describe the
 * recent window rather than everything since the server booted. Without this,
 * a p99 would be permanently dominated by the very first cold request.
 */
export function histogramDelta(
  prev: HistogramSnapshot | null,
  now: HistogramSnapshot,
): HistogramSnapshot {
  if (!prev || prev.buckets.length !== now.buckets.length) return now;

  const prevByLe = new Map(prev.buckets.map((b) => [b.le, b.count]));
  const buckets = now.buckets.map((b) => ({
    le: b.le,
    // A counter reset (server restart) makes the delta negative; fall back to
    // the absolute value, which is correct for a freshly-reset counter.
    count: Math.max(0, b.count - (prevByLe.get(b.le) ?? 0)),
  }));

  const count = Math.max(0, now.count - prev.count);
  if (count === 0) return { buckets: [], sum: 0, count: 0 };

  return { buckets, sum: Math.max(0, now.sum - prev.sum), count };
}

/** Per-second rate between two counter readings. Handles resets. */
export function rate(
  prevValue: number | null,
  nowValue: number,
  elapsedMs: number,
): number {
  if (prevValue === null || elapsedMs <= 0) return 0;
  const delta = nowValue - prevValue;
  if (delta < 0) return 0; // counter reset
  return (delta / elapsedMs) * 1000;
}

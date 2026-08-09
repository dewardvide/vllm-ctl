import "server-only";

import { getDb } from "@/lib/server/db";
import { hub } from "@/lib/server/broadcast";
import type { EngineMetrics } from "@/lib/types";

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
import { DEPLOYMENTS_TOPIC, supervisor } from "./supervisor";
import { baseUrl } from "./host";

/**
 * Polls each healthy deployment's Prometheus endpoint and turns raw counters
 * into the rates and percentiles the UI shows.
 *
 * Runs at half the telemetry rate: engine metrics move more slowly than GPU
 * telemetry, and a scrape is an HTTP round-trip rather than a 24 ms exec.
 */

const POLL_MS = 2000;

interface PrevScrape {
  ts: number;
  genTokens: number;
  promptTokens: number;
  requests: number;
  preemptions: number;
  ttft: HistogramSnapshot;
  itl: HistogramSnapshot;
}

const S = (v: number | null) => (v == null ? null : v * 1000); // seconds → ms

class MetricsPoller {
  private prev = new Map<number, PrevScrape>();
  private latest = new Map<number, EngineMetrics>();
  private timer: ReturnType<typeof setInterval> | null = null;

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.pollAll(), POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(runId: number): EngineMetrics | null {
    return this.latest.get(runId) ?? null;
  }

  forget(runId: number) {
    this.prev.delete(runId);
    this.latest.delete(runId);
  }

  private async pollAll() {
    const live = supervisor().list().filter((d) => d.status === "healthy");
    if (live.length === 0) return;

    // Drop state for deployments that have gone away.
    const alive = new Set(live.map((d) => d.runId));
    for (const id of [...this.prev.keys()]) if (!alive.has(id)) this.forget(id);

    let changed = false;
    await Promise.all(
      live.map(async (d) => {
        const m = await this.pollOne(d.runId, d.host, d.port);
        if (m) changed = true;
      }),
    );
    if (changed) supervisor().publish();
  }

  private async pollOne(
    runId: number,
    host: string,
    port: number,
  ): Promise<EngineMetrics | null> {
    const text = await scrape(host, port);
    if (text === null) return null;

    const metrics = parsePrometheusText(text);
    const now = Date.now();

    const genTokens = sumOf(metrics, "vllm:generation_tokens_total");
    const promptTokens = sumOf(metrics, "vllm:prompt_tokens_total");
    const requests = sumOf(metrics, "vllm:request_success_total");
    const preemptions = sumOf(metrics, "vllm:num_preemptions_total");

    const ttft = collectHistogram(metrics, "vllm:time_to_first_token_seconds");
    const itl = collectHistogram(metrics, "vllm:inter_token_latency_seconds");

    const prev = this.prev.get(runId) ?? null;
    const elapsed = prev ? now - prev.ts : 0;

    // Percentiles over the window since the last scrape, not since boot: an
    // all-time p99 would be pinned forever by the first cold request.
    const ttftWindow = histogramDelta(prev?.ttft ?? null, ttft);
    const itlWindow = histogramDelta(prev?.itl ?? null, itl);

    const prefixHits = sumOf(metrics, "vllm:prefix_cache_hits_total");
    const prefixQueries = sumOf(metrics, "vllm:prefix_cache_queries_total");

    const out: EngineMetrics = {
      ts: now,
      genTokS: rate(prev?.genTokens ?? null, genTokens, elapsed),
      promptTokS: rate(prev?.promptTokens ?? null, promptTokens, elapsed),
      requestsRunning: sumOf(metrics, "vllm:num_requests_running"),
      requestsWaiting: sumOf(metrics, "vllm:num_requests_waiting"),
      kvCachePct: gauge(metrics, "vllm:kv_cache_usage_perc") * 100,
      ttftP50Ms: S(histogramQuantile(ttftWindow, 0.5)),
      ttftP95Ms: S(histogramQuantile(ttftWindow, 0.95)),
      ttftP99Ms: S(histogramQuantile(ttftWindow, 0.99)),
      itlP50Ms: S(histogramQuantile(itlWindow, 0.5)),
      itlP95Ms: S(histogramQuantile(itlWindow, 0.95)),
      prefixHitPct: prefixQueries > 0 ? (prefixHits / prefixQueries) * 100 : null,
      preemptions: Math.max(0, preemptions - (prev?.preemptions ?? preemptions)),
      totalPromptTokens: promptTokens,
      totalGenTokens: genTokens,
      totalRequests: requests,
    };

    this.prev.set(runId, {
      ts: now,
      genTokens,
      promptTokens,
      requests,
      preemptions,
      ttft,
      itl,
    });
    this.latest.set(runId, out);
    this.persist(runId, out);
    return out;
  }

  private persist(runId: number, m: EngineMetrics) {
    try {
      getDb()
        .prepare(
          `INSERT OR REPLACE INTO deployment_metrics
             (ts, run_id, gen_tok_s, prompt_tok_s, requests_running, requests_waiting,
              kv_cache_pct, ttft_p50_ms, ttft_p95_ms, ttft_p99_ms,
              itl_p50_ms, itl_p95_ms, prefix_hit_pct, preemptions)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          m.ts, runId, m.genTokS, m.promptTokS, m.requestsRunning, m.requestsWaiting,
          m.kvCachePct, m.ttftP50Ms, m.ttftP95Ms, m.ttftP99Ms,
          m.itlP50Ms, m.itlP95Ms, m.prefixHitPct, m.preemptions,
        );
    } catch {
      /* metric history is nice to have, never worth failing a poll over */
    }
  }
}

async function scrape(host: string, port: number): Promise<string | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`${baseUrl(host, port)}/metrics`, {
      signal: ctl.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

declare global {
  var __vllmAdminMetrics: MetricsPoller | undefined;
}

export function metricsPoller(): MetricsPoller {
  if (!globalThis.__vllmAdminMetrics) {
    globalThis.__vllmAdminMetrics = new MetricsPoller();
    globalThis.__vllmAdminMetrics.start();
  }
  return globalThis.__vllmAdminMetrics;
}

/** Re-publishes deployment state, used after a mutation. */
export function publishDeployments() {
  hub().publish(DEPLOYMENTS_TOPIC, "state", { live: supervisor().list() });
}

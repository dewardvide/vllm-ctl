import type { EngineMetrics } from "@/lib/types";
import { parsePrometheusText } from "@/lib/vllm/prometheus";
export function llamaMetrics(text: string, ts: number, prev: EngineMetrics | null): EngineMetrics {
  const metrics = parsePrometheusText(text);
  const get = (name: string) => {
    const found = metrics.filter(m => m.name === `llamacpp:${name}`);
    return found.length ? found.reduce((sum, m) => sum + m.value, 0) : null;
  };
  const gen = get("tokens_predicted_total"), prompt = get("prompt_tokens_total");
  const rate = (now: number | null, before: number | null | undefined) => now == null || before == null || !prev || ts <= prev.ts || now < before ? null : (now - before) * 1000 / (ts - prev.ts);
  return { ts, genTokS: rate(gen, prev?.totalGenTokens), promptTokS: rate(prompt, prev?.totalPromptTokens),
    requestsRunning: get("requests_processing"), requestsWaiting: get("requests_deferred"),
    totalGenTokens: gen, totalPromptTokens: prompt, totalRequests: null,
    kvCachePct: null, preemptions: null, prefixHitPct: null,
    ttftP50Ms: null, ttftP95Ms: null, ttftP99Ms: null, itlP50Ms: null, itlP95Ms: null };
}

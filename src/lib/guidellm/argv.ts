import type { BenchmarkConfig } from "@/lib/types";

/**
 * Builds the `guidellm run` command line.
 *
 * GuideLLM takes structured options as `kind=…,key=value` blobs rather than
 * discrete flags, so this is where the run builder's form state becomes a
 * command. As with the vLLM argv builder, the preview shown in the UI and the
 * argv actually spawned come from this one function.
 *
 * Pinned to the `guidellm run` syntax. Releases before this used
 * `guidellm benchmark --rate-type`; the runner asserts the installed version
 * rather than guessing which dialect it speaks.
 */

/** The GuideLLM release this integration is written against. */
export const PINNED_GUIDELLM = "0.7.3";

function kv(kind: string, params: Record<string, string | number | undefined>): string {
  const parts = [`kind=${kind}`];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${k}=${v}`);
  }
  return parts.join(",");
}

export function buildBenchmarkArgv(
  config: BenchmarkConfig,
  outputJsonPath: string,
): string[] {
  const argv: string[] = ["run"];

  argv.push(
    "--backend",
    kv("openai_http", {
      target: config.target,
      model: config.model ?? undefined,
    }),
  );

  argv.push("--profile", buildProfile(config));
  argv.push("--data", buildData(config));

  for (const c of buildConstraints(config)) argv.push("--constraint", c);

  if (config.tokenizer) {
    argv.push("--tokenizer", kv("huggingface_auto", { model: config.tokenizer }));
  }
  if (config.seed != null) {
    argv.push("--seed", kv("static", { value: config.seed }));
  }

  argv.push("--output", kv("json", { path: outputJsonPath }));
  // The interactive console renderer emits ANSI cursor moves that make the
  // captured log unreadable; the structured JSON is what we consume anyway.
  argv.push("--disable-console-interactive");

  return argv;
}

export function buildProfile(config: BenchmarkConfig): string {
  const p = config.profile;
  switch (p.kind) {
    case "concurrent":
      return kv("concurrent", { streams: p.streams ?? 10 });
    case "throughput":
      return kv("throughput", {
        max_concurrency: p.maxConcurrency,
        rampup_duration: p.rampupDuration,
      });
    case "constant":
      return kv("constant", { rate: p.rate ?? 10 });
    case "poisson":
      return kv("poisson", { rate: p.rate ?? 10 });
    case "sweep":
      return kv("sweep", {
        sweep_size: p.sweepSize ?? 10,
        rampup_duration: p.rampupDuration,
      });
    case "synchronous":
    default:
      return kv("synchronous", {});
  }
}

export function buildData(config: BenchmarkConfig): string {
  const d = config.data;
  if (d.kind === "synthetic_text") {
    return kv("synthetic_text", {
      prompt_tokens: d.promptTokens ?? 256,
      output_tokens: d.outputTokens ?? 128,
    });
  }
  if (d.kind === "huggingface") {
    return kv("huggingface", { source: d.source });
  }
  return kv(d.kind, { path: d.source });
}

export function buildConstraints(config: BenchmarkConfig): string[] {
  const c = config.constraints;
  const out: string[] = [];
  if (c.maxSeconds != null) out.push(kv("max_duration", { seconds: c.maxSeconds }));
  if (c.maxRequests != null) out.push(kv("max_requests", { count: c.maxRequests }));
  if (c.maxErrors != null) out.push(kv("max_errors", { count: c.maxErrors }));
  if (c.maxErrorRate != null) out.push(kv("max_error_rate", { rate: c.maxErrorRate }));

  // An unconstrained sweep never terminates. Default to a minute per strategy
  // rather than letting a run hang forever waiting on a stop condition.
  if (out.length === 0) out.push(kv("max_duration", { seconds: 60 }));
  return out;
}

/**
 * Rough wall-clock estimate, so the run builder can warn before you start a
 * benchmark that will occupy the GPU for half an hour.
 */
export function estimateRunSeconds(config: BenchmarkConfig): number | null {
  const perStrategy = config.constraints.maxSeconds;
  if (perStrategy == null) return null;

  const p = config.profile;
  const strategies =
    p.kind === "sweep"
      ? (p.sweepSize ?? 10)
      : 1;

  // Each strategy also pays setup and drain time; a fixed 10 s is close enough
  // for a warning, and deliberately errs on the high side.
  return strategies * (perStrategy + 10);
}

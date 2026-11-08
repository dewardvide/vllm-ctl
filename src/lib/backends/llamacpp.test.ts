import { describe, expect, it } from "vitest";
import { buildLlamaArgv, lfmCompatible, LFM_MODEL } from "./llamacpp";
import { llamaMetrics } from "./llama-metrics";
import { deploymentLogHint } from "./adapters";
import type { LaunchSpec } from "@/lib/vllm/argv";
const spec: LaunchSpec = { backend: "llamacpp", name: "test", model: "org/model-GGUF", modelSource: { kind: "hub", quantization: "Q4_K_M" }, flags: {} };
const hp = { host: "127.0.0.1", port: 8001 };
describe("llama.cpp command construction", () => {
  it("supports both invocation modes with owned alias and metrics", () => {
    const argv = buildLlamaArgv(spec, hp, "server");
    expect(argv).toEqual(["--hf-repo", "org/model-GGUF:Q4_K_M", "--host", hp.host, "--port", "8001", "--alias", spec.model, "--metrics"]);
    expect(buildLlamaArgv(spec, hp, "serve")).toEqual(["serve", ...argv]);
  });
  it("preserves local filenames and aliases containing spaces as individual arguments", () => {
    const args = buildLlamaArgv({ ...spec, model: "/tmp/model with spaces.gguf", modelSource: { kind: "local" }, servedName: "my model", flags: { "gpu-layers": 0, mmproj: "/tmp/my projector.gguf" } }, hp, "server");
    expect(args).toContain("/tmp/model with spaces.gguf"); expect(args).toContain("my model"); expect(args).toContain("/tmp/my projector.gguf");
    expect(args).not.toContain("--hf-repo");
  });
  it("accepts an exact Hub filename", () => {
    expect(buildLlamaArgv({ ...spec, modelSource: { kind: "hub", filename: "model.Q8_0.gguf" } }, hp, "server")).toContain("--hf-file");
  });
  it.each(["host", "port", "model", "alias", "metrics", "max-model-len", "gpu-memory-utilization"])("rejects injected or foreign option %s", flag => {
    expect(() => buildLlamaArgv({ ...spec, flags: { [flag]: 1 } }, hp, "server")).toThrow();
  });
  it("requires unambiguous source selection", () => {
    for (const modelSource of [{ kind: "hub" as const }, { kind: "hub" as const, filename: "a.gguf", quantization: "Q4" }, { kind: "local" as const, quantization: "Q4" }]) {
      expect(() => buildLlamaArgv({ ...spec, modelSource }, hp, "server")).toThrow();
    }
    expect(() => buildLlamaArgv({ ...spec, flags: { threads: 1.5 } }, hp, "server")).toThrow();
  });
  it("configures LFM3 without disabling companion downloads", () => {
    const args = buildLlamaArgv({ ...spec, model: LFM_MODEL }, hp, "serve");
    expect(args.slice(-4)).toEqual(["--reasoning", "off", "--temp", "0"]);
    expect(args).not.toContain("--no-mmproj");
    expect(lfmCompatible("version: 10217 (abc)\nbuilt with GNU 12.3.0 for Linux x86_64")).toBe(false);
    expect(lfmCompatible("version: 11960 (abc)")).toBe(true);
    expect(lfmCompatible("v0.8.0")).toBe(true);
    expect(lfmCompatible("b12000")).toBe(true);
    expect(lfmCompatible("unknown")).toBe(false);
  });
});
describe("llama.cpp telemetry", () => {
  const scrape = (n: number) => `llamacpp:tokens_predicted_total ${n}\nllamacpp:prompt_tokens_total ${n * 2}\nllamacpp:requests_processing 1\nllamacpp:requests_deferred 2`;
  it("derives counter deltas and resets safely", () => {
    const first = llamaMetrics(scrape(10), 1000, null);
    expect(first.genTokS).toBeNull();
    const next = llamaMetrics(scrape(30), 3000, first);
    expect(next.genTokS).toBe(10); expect(next.promptTokS).toBe(20);
    expect(next.requestsRunning).toBe(1); expect(next.requestsWaiting).toBe(2);
    expect(llamaMetrics(scrape(2), 5000, next).genTokS).toBeNull();
    for (const k of ["kvCachePct", "preemptions", "ttftP95Ms", "totalRequests"] as const) expect(next[k]).toBeNull();
    expect(llamaMetrics("", 5000, next).totalGenTokens).toBeNull();
  });
  it("classifies download, model, missing-file and memory failures", () => {
    expect(deploymentLogHint("llamacpp", "downloading weights")?.status).toBe("loading");
    for (const msg of ["download failed", "unknown model architecture", "failed to open file", "out of memory"]) expect(deploymentLogHint("llamacpp", msg)?.fatal).toBeTruthy();
    expect(deploymentLogHint("llamacpp", "request completed")).toBeNull();
  });
});

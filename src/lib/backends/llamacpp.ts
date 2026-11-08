import type { LaunchSpec, HostPort } from "@/lib/vllm/argv";
export const LLAMA_OPTIONS = ["ctx-size", "gpu-layers", "threads", "parallel", "batch-size", "ubatch-size", "mmproj"] as const;
export const LFM_MODEL = "LiquidAI/LFM3-Omni-2B-GGUF";
export function isLfm(model: string) { return model.split(":")[0] === LFM_MODEL; }
export function buildLlamaArgv(spec: LaunchSpec, hp: HostPort, mode: "server" | "serve"): string[] {
  const source = spec.modelSource;
  if (!source) throw new Error("Choose a llama.cpp model source.");
  if (Object.keys(spec.flags).some(k => !LLAMA_OPTIONS.includes(k as typeof LLAMA_OPTIONS[number]))) throw new Error("Unsupported llama.cpp option; vLLM flags cannot be used here.");
  const args = mode === "serve" ? ["serve"] : [];
  if (source.kind === "local") {
    if (source.quantization || source.filename) throw new Error("Local models cannot have Hub source fields.");
    if (!spec.model.toLowerCase().endsWith(".gguf")) throw new Error("Choose a local .gguf file.");
    args.push("--model", spec.model);
  } else if (source.kind === "hub") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(spec.model)) throw new Error("Use a Hub repository ID without a quantization suffix; select quantization separately.");
    if (!source.quantization && !source.filename) throw new Error("Choose a quantization or exact Hub filename.");
    if (source.quantization && !/^[\w.-]+$/.test(source.quantization)) throw new Error("Invalid quantization.");
    if (source.quantization && source.filename) throw new Error("Choose either quantization or filename, not both.");
    args.push("--hf-repo", spec.model + (source.quantization ? `:${source.quantization}` : ""));
    if (source.filename) args.push("--hf-file", source.filename);
  } else throw new Error("Invalid model source.");
  args.push("--host", hp.host, "--port", String(hp.port), "--alias", spec.servedName || spec.model, "--metrics");
  for (const [key, value] of Object.entries(spec.flags)) {
    if (key === "mmproj") {
      if (typeof value !== "string" || !value.trim()) throw new Error("Projector must be a file path.");
    } else if (typeof value !== "number" || !Number.isInteger(value) || value < (key === "gpu-layers" ? -1 : key === "ctx-size" ? 0 : 1)) throw new Error(`Invalid --${key}.`);
    args.push(`--${key}`, String(value));
  }
  if (isLfm(spec.model)) args.push("--reasoning", "off", "--temp", "0");
  return args;
}
export function lfmCompatible(version: string): boolean {
  const build = version.match(/(?:\bb|build[: ]+|version:\s*)(\d{4,})/i);
  if (build) return Number(build[1]) >= 11960;
  const semver = version.match(/(?:^|\bversion:\s*|\bv)(\d+)\.(\d+)\.(\d+)\b/m);
  return !!(semver && (Number(semver[1]) > 0 || Number(semver[2]) >= 8));
}

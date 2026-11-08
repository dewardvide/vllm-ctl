import "server-only";
import path from "node:path";
import { getSettings, effectiveHfToken, detectCudaHome } from "@/lib/settings";
import type { BackendId } from "@/lib/types";
import { classifyLogLine, type PhaseHint } from "@/lib/vllm/phase";
import { baseUrl } from "@/lib/vllm/host";

export function deploymentEnvironment(backend: BackendId, extra?: Record<string, string>): NodeJS.ProcessEnv {
  const settings = getSettings();
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const token = effectiveHfToken(settings);
  if (token) env.HF_TOKEN = token;
  if (backend === "llamacpp") {
    // Do not let inherited llama argument variables override app-owned settings.
    for (const key of Object.keys(env)) if (key.startsWith("LLAMA_ARG_")) delete env[key];
    env.LLAMA_CACHE = settings.llamaCacheDir;
    return env;
  }
  env.HF_HUB_CACHE = settings.hfCacheDir;
  env.PYTHONUNBUFFERED = "1";
  const paths: string[] = [];
  if (settings.vllmBinDir) paths.push(settings.vllmBinDir);
  const cuda = settings.cudaHome ?? detectCudaHome(settings.vllmBinDir);
  if (cuda) { env.CUDA_HOME = cuda; paths.push(path.join(cuda, "bin")); }
  env.PATH = [...paths, env.PATH ?? ""].join(path.delimiter);
  return env;
}

export function deploymentLogHint(backend: BackendId, text: string): PhaseHint | null {
  if (backend === "vllm") return classifyLogLine(text);
  if (/out of memory|failed to allocate|cudaMalloc.*failed/i.test(text)) return { fatal: "Out of memory. Reduce context, GPU layers or batch sizes, or stop another deployment." };
  if (/unknown model architecture|unsupported model/i.test(text)) return { fatal: "Unsupported model. Upgrade llama.cpp to a compatible build." };
  if (/failed to open|no such file|not found.*gguf/i.test(text)) return { fatal: "Model or projector file not found. Check the GGUF paths." };
  if (/error.*download|download.*failed|HTTP.*(?:401|403|404)/i.test(text)) return { fatal: "Model download failed. Check repository, filename, quantization and Hugging Face credentials." };
  if (/error:|failed to load model/i.test(text)) return { fatal: text };
  if (/download/i.test(text)) return { phase: "downloading model", status: "loading" };
  if (/load|tensor|buffer|init/i.test(text)) return { phase: "loading model", status: "loading" };
  return null;
}

export async function deploymentHealth(backend: BackendId, host: string, port: number): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl(host, port)}/health`, { signal: AbortSignal.timeout(2000), cache: "no-store" });
    if (!res.ok) return false;
    if (backend === "llamacpp") {
      const body = await res.json();
      return body.status === "ok";
    }
    return true;
  } catch { return false; }
}

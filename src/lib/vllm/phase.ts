import type { DeploymentStatus } from "@/lib/types";

/**
 * Turns vLLM's own log output into a short phase label.
 *
 * Weight loading and CUDA graph capture can take minutes, during which /health
 * refuses connections. Without this the UI would show an unchanging "starting"
 * and look hung; with it, the user sees the engine actually making progress.
 *
 * Patterns are matched in order, most specific first.
 */

interface PhaseRule {
  re: RegExp;
  phase: string;
  /** Set when a line proves the process has moved past bare spawn. */
  status?: DeploymentStatus;
}

const RULES: PhaseRule[] = [
  { re: /Application startup complete|Uvicorn running on/i, phase: "serving", status: "healthy" },
  { re: /Starting vLLM API server|Route: \/v1/i, phase: "starting api server", status: "loading" },
  { re: /Capturing CUDA graph|capturing cudagraphs|Graph capturing finished/i, phase: "capturing cuda graphs", status: "loading" },
  { re: /torch\.compile|Compiling a graph|Dynamo bytecode transform/i, phase: "compiling graphs", status: "loading" },
  { re: /GPU KV cache size|Available KV cache memory|# GPU blocks:/i, phase: "sizing kv cache", status: "loading" },
  { re: /Memory profiling|determine_available_memory/i, phase: "profiling memory", status: "loading" },
  { re: /Loading weights took|Model loading took|Loading safetensors checkpoint/i, phase: "loading weights", status: "loading" },
  { re: /Starting to load model|init engine|Initializing a V\d+ LLM engine/i, phase: "initialising engine", status: "loading" },
  { re: /Downloading|Fetching \d+ files/i, phase: "downloading weights", status: "loading" },
];

/** Log lines that mean the launch has definitively failed. */
const FATAL: Array<{ re: RegExp; message: string }> = [
  {
    re: /torch\.OutOfMemoryError|CUDA out of memory|No available memory for the cache blocks/i,
    message:
      "Out of GPU memory. Lower --gpu-memory-utilization or --max-model-len, or stop another deployment.",
  },
  {
    re: /The model's max seq len \((\d+)\) is larger than the maximum number of tokens/i,
    message:
      "Requested --max-model-len does not fit in the KV cache. Reduce it, or raise --gpu-memory-utilization.",
  },
  {
    re: /No such file or directory: 'ninja'|Ninja is required to load C\+\+ extensions/i,
    message:
      "The `ninja` build tool is missing, so torch cannot compile its C++ extensions. " +
      "Install it into the vLLM environment with `pip install ninja`.",
  },
  {
    re: /Could not find nvcc|cuda_home=.*doesn't exist|CUDA_HOME.*not set/i,
    message:
      "The CUDA toolkit (nvcc) is not installed, so vLLM cannot compile kernels. " +
      "Set --enforce-eager to skip compilation, or install a CUDA toolkit matching your driver.",
  },
  {
    re: /address already in use|Address already in use/i,
    message: "Port is already in use by another process.",
  },
  {
    re: /Cannot find model module|does not appear to have a file named config\.json|is not a local folder and is not a valid model identifier/i,
    message: "Model not found. Check the repo id, or download it first.",
  },
  {
    re: /401 Client Error|Access to model .* is restricted|You are trying to access a gated repo/i,
    message: "Access denied by Hugging Face. This repo is gated — add a token in Settings.",
  },
  {
    re: /ValueError: Unsupported quantization|Quantization method .* is not supported/i,
    message: "This quantization format is not supported by the installed vLLM build.",
  },
];

export interface PhaseHint {
  phase?: string;
  status?: DeploymentStatus;
  fatal?: string;
}

export function classifyLogLine(text: string): PhaseHint | null {
  for (const f of FATAL) {
    if (f.re.test(text)) return { fatal: f.message };
  }
  for (const r of RULES) {
    if (r.re.test(text)) return { phase: r.phase, status: r.status };
  }
  return null;
}

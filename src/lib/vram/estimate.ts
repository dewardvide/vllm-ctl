import type { ModelArchInfo, VramEstimate } from "@/lib/types";

/**
 * Estimates the VRAM a deployment will need.
 *
 * This is what stops you from discovering a bad configuration ninety seconds
 * into a weight load, and it's what draws the ghost segment on the headroom
 * rail. It is deliberately an *estimate*: vLLM's real allocator also holds
 * CUDA graphs, activation buffers and fragmentation that no static formula
 * predicts exactly. The notes returned alongside the numbers say so.
 *
 * Weights:  params × bytes-per-param(dtype)
 * KV cache: 2 (K and V) × layers × kv_heads × head_dim × bytes(kv_dtype)
 *           per token, which is the figure that actually decides how long a
 *           context you can serve.
 */

export const DTYPE_BYTES: Record<string, number> = {
  float32: 4,
  float: 4,
  fp32: 4,
  bfloat16: 2,
  bf16: 2,
  float16: 2,
  fp16: 2,
  half: 2,
  fp8: 1,
  fp8_e4m3: 1,
  fp8_e5m2: 1,
  int8: 1,
  fp4: 0.5,
  int4: 0.5,
};

/** Effective bytes per weight for a quantization scheme, including scales. */
export const QUANT_BYTES: Record<string, number> = {
  awq: 0.55, // 4-bit weights + group scales/zeros
  gptq: 0.55,
  "compressed-tensors": 1.05,
  fp8: 1.05,
  bitsandbytes: 0.6,
  bnb: 0.6,
  gguf: 0.6,
  marlin: 0.55,
  awq_marlin: 0.55,
  gptq_marlin: 0.55,
  int8: 1.05,
  modelopt: 1.05,
  // MXFP4: 4-bit elements plus one 8-bit shared scale per 32, so 4.25 bits.
  mxfp4: 0.53,
  nvfp4: 0.55,
  fp4: 0.53,
};

export interface EstimateInput {
  arch: ModelArchInfo;
  /** `--max-model-len`; falls back to the model's own maximum. */
  maxModelLen: number;
  /** `--gpu-memory-utilization`, the fraction of the card vLLM may claim. */
  gpuMemoryUtilization: number;
  /** `--kv-cache-dtype`; "auto" follows the model dtype. */
  kvCacheDtype: string;
  /** `--dtype`; "auto" follows the checkpoint's `torch_dtype`. */
  dtype: string;
  /** `--tensor-parallel-size`. Weights and KV split across this many GPUs. */
  tensorParallelSize: number;
  /** Total VRAM on one device, MiB. */
  totalVramMiB: number;
  /** VRAM already in use on that device, MiB. */
  usedVramMiB: number;
  /** Fraction of total that must stay free after this deployment starts. */
  safetyMargin: number;
}

const GIB = 1024 ** 3;

function bytesPerWeight(dtype: string, quantization: string | null): number {
  if (quantization) {
    const q = QUANT_BYTES[quantization.toLowerCase()];
    if (q) return q;
  }
  return DTYPE_BYTES[dtype.toLowerCase()] ?? 2;
}

/**
 * Effective bytes per weight for a checkpoint, from its quantization if it has
 * one and otherwise its dtype. Shared with the cache reader, which uses it to
 * turn a measured file size back into a parameter count.
 */
export function effectiveBytesPerWeight(arch: ModelArchInfo): number {
  return bytesPerWeight(arch.torchDtype ?? "bfloat16", arch.quantization);
}

function resolveDtype(requested: string, arch: ModelArchInfo): string {
  if (requested && requested !== "auto") return requested;
  return arch.torchDtype ?? "bfloat16";
}

function resolveKvDtype(requested: string, modelDtype: string): string {
  if (requested && requested !== "auto") return requested;
  return modelDtype;
}

/**
 * Falls back to the standard transformer parameter count when `config.json`
 * does not state one, which is the common case — HF configs carry shape, not
 * totals.
 */
export function estimateParamCount(arch: ModelArchInfo): number | null {
  if (arch.numParams && arch.numParams > 0) return arch.numParams;

  const L = arch.numHiddenLayers;
  const H = arch.hiddenSize;
  const V = arch.vocabSize;
  if (!L || !H || !V) return null;

  // Attention: q,k,v,o projections. With GQA, k and v are narrower.
  const heads = arch.numAttentionHeads ?? Math.max(1, Math.round(H / 128));
  const kvHeads = arch.numKeyValueHeads ?? heads;
  const headDim = arch.headDim ?? Math.round(H / heads);

  const qProj = H * heads * headDim;
  const kProj = H * kvHeads * headDim;
  const vProj = H * kvHeads * headDim;
  const oProj = heads * headDim * H;
  const attn = qProj + kProj + vProj + oProj;

  // MLP: assume a gated (SwiGLU) MLP at the near-universal ~3.5x expansion.
  const mlp = 3 * H * Math.round(H * 3.5);

  const perLayer = attn + mlp + 2 * H; // + two RMSNorms
  const embeddings = V * H * 2; // input embedding + LM head, untied

  return L * perLayer + embeddings;
}

export function kvBytesPerToken(arch: ModelArchInfo, kvDtype: string): number | null {
  const L = arch.numHiddenLayers;
  if (!L) return null;
  const heads = arch.numAttentionHeads ?? null;
  const kvHeads = arch.numKeyValueHeads ?? heads;
  const headDim =
    arch.headDim ?? (arch.hiddenSize && heads ? Math.round(arch.hiddenSize / heads) : null);
  if (!kvHeads || !headDim) return null;

  const bytes = DTYPE_BYTES[kvDtype.toLowerCase()] ?? 2;
  return 2 * L * kvHeads * headDim * bytes; // 2 = K and V
}

export function estimateVram(input: EstimateInput): VramEstimate {
  const notes: string[] = [];
  const {
    arch,
    maxModelLen,
    gpuMemoryUtilization,
    totalVramMiB,
    usedVramMiB,
    safetyMargin,
  } = input;

  const tp = Math.max(1, input.tensorParallelSize || 1);
  const dtype = resolveDtype(input.dtype, arch);
  const kvDtype = resolveKvDtype(input.kvCacheDtype, dtype);

  const params = estimateParamCount(arch);
  const bpw = bytesPerWeight(dtype, arch.quantization);

  // Measured beats derived. Inferring weight size from a parameter count means
  // guessing the effective width of the checkpoint's quantization, which is
  // where a format the app has not seen goes wrong.
  let weightsGiB = 0;
  let weightsKnown = false;
  if (arch.weightBytes) {
    weightsGiB = arch.weightBytes / GIB / tp;
    weightsKnown = true;
  } else if (params) {
    weightsGiB = (params * bpw) / GIB / tp;
    weightsKnown = true;
  } else {
    notes.push("Parameter count unknown — weight size could not be estimated.");
  }

  const kvPerTokenBytes = kvBytesPerToken(arch, kvDtype);
  let kvPerTokenKiB = 0;
  let kvAtContextGiB = 0;
  if (kvPerTokenBytes) {
    kvPerTokenKiB = kvPerTokenBytes / 1024 / tp;
    kvAtContextGiB = (kvPerTokenBytes * maxModelLen) / GIB / tp;
  } else {
    notes.push("Attention shape unknown — KV cache size could not be estimated.");
  }

  if (arch.slidingWindow && arch.slidingWindow < maxModelLen) {
    notes.push(
      `Sliding-window attention (${arch.slidingWindow.toLocaleString()} tokens) means real KV use is lower than shown.`,
    );
  }
  if (arch.quantization) {
    notes.push(`Weights are ${arch.quantization}; sizes are approximate for this format.`);
  }

  // CUDA context, activation buffers and captured graphs. Roughly constant on
  // a single card and dominated by graph capture; --enforce-eager avoids most.
  const activationOverheadGiB = 1.2;

  // An estimate missing either component is not an estimate.
  const known = weightsKnown && kvPerTokenBytes !== null;

  const totalGiB = weightsGiB + kvAtContextGiB + activationOverheadGiB;

  // vLLM only claims `gpu_memory_utilization` of the *whole* card, and it
  // counts memory already in use by other processes against that budget.
  const budgetGiB = (totalVramMiB / 1024) * gpuMemoryUtilization;
  const usedGiB = usedVramMiB / 1024;
  const marginGiB = (totalVramMiB / 1024) * safetyMargin;
  const availableGiB = Math.max(0, budgetGiB - usedGiB - marginGiB);

  const fits = known && totalGiB > 0 && totalGiB <= availableGiB;

  let maxContextThatFits: number | null = null;
  if (known && kvPerTokenBytes) {
    const kvBudgetGiB = availableGiB - weightsGiB - activationOverheadGiB;
    const tokens = Math.floor((kvBudgetGiB * GIB) / (kvPerTokenBytes / tp));
    maxContextThatFits = tokens > 0 ? tokens : 0;
  }

  if (!known) {
    notes.push("Not enough information to verify this fits — start it with care.");
  } else if (!fits && weightsGiB > availableGiB) {
    notes.push("The weights alone exceed the available budget — try a quantized build.");
  } else if (!fits && maxContextThatFits && maxContextThatFits > 0) {
    notes.push(
      `Reduce --max-model-len to about ${maxContextThatFits.toLocaleString()} tokens to fit.`,
    );
  }

  return {
    weightsGiB,
    kvPerTokenKiB,
    kvAtContextGiB,
    activationOverheadGiB,
    totalGiB,
    availableGiB,
    known,
    fits,
    maxContextThatFits,
    notes,
  };
}

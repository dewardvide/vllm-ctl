import { describe, expect, it } from "vitest";

import type { ModelArchInfo } from "@/lib/types";
import { estimateParamCount, estimateVram, kvBytesPerToken } from "./estimate";

/**
 * Ground truth for granite-4.1-8b comes from the tuning notes in the user's
 * existing serve.py, which were derived by actually running the model on this
 * 3090: "bf16 weights take ~15.6 GiB and each KV token costs 160 KiB".
 */
const GRANITE: ModelArchInfo = {
  architectures: ["GraniteForCausalLM"],
  modelType: "granite",
  numParams: 8.4e9,
  numHiddenLayers: 40,
  hiddenSize: 4096,
  numAttentionHeads: 32,
  numKeyValueHeads: 8,
  headDim: 128,
  vocabSize: 49155,
  maxPositionEmbeddings: 131072,
  torchDtype: "bfloat16",
  quantization: null,
  slidingWindow: null,
};

const RTX3090_MIB = 24576;

const base = {
  maxModelLen: 16384,
  gpuMemoryUtilization: 0.9,
  kvCacheDtype: "auto",
  dtype: "auto",
  tensorParallelSize: 1,
  totalVramMiB: RTX3090_MIB,
  usedVramMiB: 100,
  safetyMargin: 0.03,
};

describe("kvBytesPerToken", () => {
  it("matches the documented 160 KiB/token for granite-4.1-8b", () => {
    const b = kvBytesPerToken(GRANITE, "bfloat16");
    expect(b).toBe(2 * 40 * 8 * 128 * 2);
    expect(b! / 1024).toBe(160);
  });

  it("halves with an fp8 KV cache", () => {
    const bf16 = kvBytesPerToken(GRANITE, "bfloat16")!;
    expect(kvBytesPerToken(GRANITE, "fp8_e4m3")).toBe(bf16 / 2);
  });

  it("derives head_dim from hidden_size when it is absent", () => {
    const arch = { ...GRANITE, headDim: null };
    expect(kvBytesPerToken(arch, "bfloat16")).toBe(2 * 40 * 8 * 128 * 2);
  });

  it("returns null when the attention shape is unknown", () => {
    expect(
      kvBytesPerToken({ ...GRANITE, numHiddenLayers: null }, "bfloat16"),
    ).toBeNull();
  });
});

describe("estimateVram", () => {
  it("reproduces the documented ~15.6 GiB of bf16 weights", () => {
    const e = estimateVram({ arch: GRANITE, ...base });
    expect(e.weightsGiB).toBeGreaterThan(15.3);
    expect(e.weightsGiB).toBeLessThan(15.9);
  });

  it("fits granite at 16k context on a 24 GB card, as configured today", () => {
    const e = estimateVram({ arch: GRANITE, ...base });
    expect(e.fits).toBe(true);
  });

  it("rejects the advertised 131k context, which is known not to fit", () => {
    const e = estimateVram({ arch: GRANITE, ...base, maxModelLen: 131072 });
    expect(e.fits).toBe(false);
    expect(e.notes.join(" ")).toMatch(/reduce --max-model-len/i);
  });

  it("suggests a context length that does fit, and that length does fit", () => {
    const e = estimateVram({ arch: GRANITE, ...base, maxModelLen: 131072 });
    expect(e.maxContextThatFits).toBeGreaterThan(1000);
    const retry = estimateVram({
      arch: GRANITE,
      ...base,
      maxModelLen: e.maxContextThatFits!,
    });
    expect(retry.fits).toBe(true);
  });

  it("roughly doubles the usable context with an fp8 KV cache", () => {
    const bf16 = estimateVram({ arch: GRANITE, ...base, maxModelLen: 131072 });
    const fp8 = estimateVram({
      arch: GRANITE,
      ...base,
      maxModelLen: 131072,
      kvCacheDtype: "fp8_e4m3",
    });
    expect(fp8.maxContextThatFits!).toBeGreaterThan(bf16.maxContextThatFits! * 1.8);
  });

  it("frees roughly 10 GiB when the weights are 4-bit quantized", () => {
    const bnb = estimateVram({
      arch: { ...GRANITE, quantization: "bitsandbytes" },
      ...base,
    });
    const full = estimateVram({ arch: GRANITE, ...base });
    expect(full.weightsGiB - bnb.weightsGiB).toBeGreaterThan(8);
  });

  it("shrinks per-GPU usage under tensor parallelism", () => {
    const tp2 = estimateVram({ arch: GRANITE, ...base, tensorParallelSize: 2 });
    const tp1 = estimateVram({ arch: GRANITE, ...base });
    expect(tp2.weightsGiB).toBeCloseTo(tp1.weightsGiB / 2, 3);
    expect(tp2.kvAtContextGiB).toBeCloseTo(tp1.kvAtContextGiB / 2, 3);
  });

  it("counts VRAM already held by another deployment against the budget", () => {
    const busy = estimateVram({ arch: GRANITE, ...base, usedVramMiB: 12000 });
    const idle = estimateVram({ arch: GRANITE, ...base });
    expect(busy.availableGiB).toBeLessThan(idle.availableGiB);
    expect(busy.fits).toBe(false);
  });

  it("reports when the weights alone cannot fit", () => {
    const huge: ModelArchInfo = { ...GRANITE, numParams: 70e9 };
    const e = estimateVram({ arch: huge, ...base });
    expect(e.fits).toBe(false);
    expect(e.notes.join(" ")).toMatch(/weights alone/i);
  });

  it("notes sliding-window attention rather than over-reporting KV use", () => {
    const e = estimateVram({
      arch: { ...GRANITE, slidingWindow: 4096 },
      ...base,
    });
    expect(e.notes.join(" ")).toMatch(/sliding-window/i);
  });

  it("degrades gracefully when config.json is uninformative", () => {
    const unknown: ModelArchInfo = {
      architectures: [],
      modelType: null,
      numParams: null,
      numHiddenLayers: null,
      hiddenSize: null,
      numAttentionHeads: null,
      numKeyValueHeads: null,
      headDim: null,
      vocabSize: null,
      maxPositionEmbeddings: null,
      torchDtype: null,
      quantization: null,
      slidingWindow: null,
    };
    const e = estimateVram({ arch: unknown, ...base });
    expect(e.notes.length).toBeGreaterThan(0);
    // Fails closed: an unverifiable model must never be reported as fitting.
    expect(e.known).toBe(false);
    expect(e.fits).toBe(false);
  });

  it("marks a fully-specified model as known", () => {
    expect(estimateVram({ arch: GRANITE, ...base }).known).toBe(true);
  });
});

describe("estimateParamCount", () => {
  it("prefers a stated parameter count", () => {
    expect(estimateParamCount(GRANITE)).toBe(8.4e9);
  });

  it("lands within ~15% when deriving the count from layer shapes", () => {
    const derived = estimateParamCount({ ...GRANITE, numParams: null })!;
    expect(derived).toBeGreaterThan(8.4e9 * 0.85);
    expect(derived).toBeLessThan(8.4e9 * 1.15);
  });

  it("returns null when shapes are missing", () => {
    expect(
      estimateParamCount({ ...GRANITE, numParams: null, hiddenSize: null }),
    ).toBeNull();
  });
});

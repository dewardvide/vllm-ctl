import "server-only";

import { effectiveHfToken, getSettings } from "@/lib/settings";
import type { HubSearchResult, ModelArchInfo } from "@/lib/types";

import { effectiveBytesPerWeight } from "@/lib/vram/estimate";

import { parseModelConfig, scanCache } from "./cache";

/** Hugging Face Hub API client — search, metadata, and config lookup. */

const API = "https://huggingface.co/api";

function headers(): HeadersInit {
  const h: Record<string, string> = { Accept: "application/json" };
  const token = effectiveHfToken(getSettings());
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Detects the quantization format from tags and file names. */
export function detectQuantization(
  tags: string[] = [],
  files: string[] = [],
  repoId = "",
): string | null {
  const hay = [...tags, ...files, repoId].join(" ").toLowerCase();
  // Order matters: `awq_marlin` should read as AWQ, and GGUF wins over all
  // because it is a container format vLLM treats differently.
  if (/\.gguf\b|\bgguf\b/.test(hay)) return "gguf";
  if (/\bawq\b/.test(hay)) return "awq";
  if (/\bgptq\b/.test(hay)) return "gptq";
  if (/\bfp8\b|w8a8|float8/.test(hay)) return "fp8";
  if (/\bint4\b|\bw4a16\b/.test(hay)) return "int4";
  if (/\bint8\b/.test(hay)) return "int8";
  if (/bitsandbytes|\bbnb\b|-4bit\b/.test(hay)) return "bitsandbytes";
  if (/compressed-tensors/.test(hay)) return "compressed-tensors";
  return null;
}

interface HubModel {
  id?: string;
  modelId?: string;
  author?: string;
  downloads?: number;
  likes?: number;
  lastModified?: string;
  tags?: string[];
  pipeline_tag?: string;
  gated?: boolean | string;
  /** `size` is only populated when the model is fetched with `blobs=true`. */
  siblings?: Array<{ rfilename: string; size?: number }>;
}

export async function searchModels(
  query: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<HubSearchResult[]> {
  const params = new URLSearchParams({
    search: query,
    limit: String(opts.limit ?? 30),
    sort: "downloads",
    direction: "-1",
    filter: "text-generation",
  });
  // `full=false` keeps the payload small; siblings are fetched on demand.
  const res = await fetch(`${API}/models?${params}`, {
    headers: headers(),
    signal: opts.signal,
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Hugging Face search failed (${res.status}). ${await safeText(res)}`);
  }
  const rows = (await res.json()) as HubModel[];

  const cached = new Set((await scanCache()).map((r) => r.repoId));

  return rows.map((m) => {
    const repoId = m.id ?? m.modelId ?? "";
    return {
      repoId,
      author: m.author ?? repoId.split("/")[0] ?? null,
      downloads: m.downloads ?? 0,
      likes: m.likes ?? 0,
      lastModified: m.lastModified ?? null,
      tags: m.tags ?? [],
      pipelineTag: m.pipeline_tag ?? null,
      gated: m.gated ?? false,
      quantization: detectQuantization(m.tags, [], repoId),
      cached: cached.has(repoId),
    };
  });
}

export interface HubModelDetail extends HubSearchResult {
  files: Array<{ path: string; size: number | null }>;
  totalSizeBytes: number | null;
  config: ModelArchInfo | null;
  cardUrl: string;
}

export async function getModelDetail(repoId: string): Promise<HubModelDetail> {
  const res = await fetch(`${API}/models/${repoId}?blobs=true`, {
    headers: headers(),
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? `Access to ${repoId} is restricted. Add a Hugging Face token in Settings.`
        : `Could not load ${repoId} (${res.status}).`,
    );
  }
  const m = (await res.json()) as HubModel & {
    siblings?: Array<{ rfilename: string; size?: number }>;
  };

  const files = (m.siblings ?? []).map((s) => ({
    path: s.rfilename,
    size: s.size ?? null,
  }));
  const weightBytes = files
    .filter((f) => /\.(safetensors|bin|gguf)$/.test(f.path))
    .reduce((a, f) => a + (f.size ?? 0), 0);

  const config = await fetchConfig(repoId).catch(() => null);
  if (config && !config.weightBytes && weightBytes > 0) config.weightBytes = weightBytes;
  const cached = new Set((await scanCache()).map((r) => r.repoId));

  return {
    repoId,
    author: m.author ?? repoId.split("/")[0] ?? null,
    downloads: m.downloads ?? 0,
    likes: m.likes ?? 0,
    lastModified: m.lastModified ?? null,
    tags: m.tags ?? [],
    pipelineTag: m.pipeline_tag ?? null,
    gated: m.gated ?? false,
    quantization:
      config?.quantization ??
      detectQuantization(m.tags, files.map((f) => f.path), repoId),
    cached: cached.has(repoId),
    files: files.sort((a, b) => (b.size ?? 0) - (a.size ?? 0)),
    totalSizeBytes: weightBytes > 0 ? weightBytes : null,
    config,
    cardUrl: `https://huggingface.co/${repoId}`,
  };
}

/**
 * Fetches `config.json` and, when available, the safetensors index — the pair
 * that lets the VRAM estimator work on a model that isn't downloaded yet.
 */
export async function fetchConfig(repoId: string): Promise<ModelArchInfo | null> {
  const res = await fetch(`https://huggingface.co/${repoId}/resolve/main/config.json`, {
    headers: headers(),
    cache: "no-store",
  });
  if (!res.ok) return null;
  const arch = parseModelConfig(await res.json());

  try {
    const idxRes = await fetch(
      `https://huggingface.co/${repoId}/resolve/main/model.safetensors.index.json`,
      { headers: headers(), cache: "no-store" },
    );
    if (idxRes.ok) {
      const idx = (await idxRes.json()) as {
        metadata?: { total_parameters?: number; total_size?: number };
      };
      // Measured weight bytes are what the VRAM estimate wants; the parameter
      // count is only displayed, and deriving it must account for quantization.
      if (idx.metadata?.total_size) arch.weightBytes = idx.metadata.total_size;
      if (idx.metadata?.total_parameters) {
        arch.numParams = idx.metadata.total_parameters;
      } else if (idx.metadata?.total_size) {
        const bpw = effectiveBytesPerWeight(arch);
        arch.numParams = bpw > 0 ? Math.round(idx.metadata.total_size / bpw) : null;
      }
    }
  } catch {
    /* single-shard models have no index; the estimator falls back to shapes */
  }

  return arch;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

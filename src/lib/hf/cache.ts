import "server-only";

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getSettings } from "@/lib/settings";
import { effectiveBytesPerWeight } from "@/lib/vram/estimate";
import type { CachedRepo, CachedRevision, ModelArchInfo } from "@/lib/types";

/**
 * Reads the Hugging Face hub cache directly.
 *
 * The layout is stable and documented:
 *
 *   <cache>/models--org--name/
 *     blobs/<sha>          the actual file content, deduplicated
 *     snapshots/<rev>/...  symlinks into blobs
 *     refs/<ref>           a file containing the revision hash
 *
 * Reading it in TypeScript rather than shelling out to Python keeps the models
 * page a filesystem walk instead of a 1–2 second interpreter start, which is
 * the difference between the page feeling instant and feeling like a CLI.
 *
 * The subtlety that makes a naive implementation wrong: two revisions share
 * blobs. Summing per-revision sizes double-counts, so real on-disk size is
 * computed by visiting each *blob* once.
 */

const REPO_PREFIX = /^(models|datasets|spaces)--/;

function decodeRepoDir(dirName: string): { repoId: string; repoType: CachedRepo["repoType"] } | null {
  const m = REPO_PREFIX.exec(dirName);
  if (!m) return null;
  const kind = m[1];
  const rest = dirName.slice(m[0].length);
  return {
    repoId: rest.replace(/--/g, "/"),
    repoType: kind === "models" ? "model" : kind === "datasets" ? "dataset" : "space",
  };
}

export function encodeRepoDir(repoId: string, repoType: CachedRepo["repoType"] = "model"): string {
  const prefix = repoType === "model" ? "models" : repoType === "dataset" ? "datasets" : "spaces";
  return `${prefix}--${repoId.replace(/\//g, "--")}`;
}

async function dirSize(dir: string): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes: 0, count: 0 };
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await dirSize(p);
      bytes += sub.bytes;
      count += sub.count;
    } else if (e.isFile()) {
      try {
        // lstat, not stat: blobs are real files here, and we must not follow a
        // symlink out of the blobs directory and count content twice.
        const st = await fsp.lstat(p);
        bytes += st.size;
        count++;
      } catch {
        /* a file removed mid-scan is not an error */
      }
    }
  }
  return { bytes, count };
}

/** Bytes reachable from one snapshot, resolving symlinks into blobs. */
async function snapshotSize(dir: string, seen: Set<string>): Promise<number> {
  let bytes = 0;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      bytes += await snapshotSize(p, seen);
      continue;
    }
    try {
      const real = await fsp.realpath(p);
      if (seen.has(real)) continue;
      seen.add(real);
      const st = await fsp.stat(p);
      bytes += st.size;
    } catch {
      /* dangling symlink from an interrupted download */
    }
  }
  return bytes;
}

export async function scanCache(cacheDir = getSettings().hfCacheDir): Promise<CachedRepo[]> {
  let dirs: fs.Dirent[];
  try {
    dirs = await fsp.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const repos: CachedRepo[] = [];

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const decoded = decodeRepoDir(d.name);
    if (!decoded) continue;

    const repoPath = path.join(cacheDir, d.name);
    const snapshotsDir = path.join(repoPath, "snapshots");
    const refsDir = path.join(repoPath, "refs");

    // ref name → revision hash
    const refsByHash = new Map<string, string[]>();
    try {
      for (const ref of await fsp.readdir(refsDir)) {
        const hash = (await fsp.readFile(path.join(refsDir, ref), "utf8")).trim();
        const list = refsByHash.get(hash) ?? [];
        list.push(ref);
        refsByHash.set(hash, list);
      }
    } catch {
      /* a repo with no refs is still a valid cache entry */
    }

    const revisions: CachedRevision[] = [];
    // Shared across revisions so a blob referenced twice is counted once.
    const seenBlobs = new Set<string>();

    let revDirs: string[] = [];
    try {
      revDirs = await fsp.readdir(snapshotsDir);
    } catch {
      /* no snapshots yet */
    }

    for (const hash of revDirs) {
      const snapPath = path.join(snapshotsDir, hash);
      let lastModified = 0;
      try {
        lastModified = (await fsp.stat(snapPath)).mtimeMs;
      } catch {
        continue;
      }
      revisions.push({
        hash,
        refs: refsByHash.get(hash) ?? [],
        sizeBytes: await snapshotSize(snapPath, seenBlobs),
        lastModified,
        snapshotPath: snapPath,
      });
    }

    // The blobs directory is the truth for disk usage: it includes content not
    // referenced by any current snapshot, such as a partially-replaced file.
    const blobs = await dirSize(path.join(repoPath, "blobs"));

    let lastAccessed = 0;
    try {
      lastAccessed = (await fsp.stat(repoPath)).mtimeMs;
    } catch {
      /* keep zero */
    }

    repos.push({
      repoId: decoded.repoId,
      repoType: decoded.repoType,
      sizeBytes: blobs.bytes,
      revisions: revisions.sort((a, b) => b.lastModified - a.lastModified),
      lastAccessed,
      path: repoPath,
    });
  }

  return repos.sort((a, b) => b.sizeBytes - a.sizeBytes);
}

export async function findCachedRepo(
  repoId: string,
  repoType: CachedRepo["repoType"] = "model",
): Promise<CachedRepo | null> {
  const repos = await scanCache();
  return repos.find((r) => r.repoId === repoId && r.repoType === repoType) ?? null;
}

/**
 * Deletes a whole repo, or one revision of it.
 *
 * Removing a single revision leaves its blobs behind, so unreferenced blobs are
 * garbage-collected afterwards — otherwise "delete" would free no disk at all,
 * which is the outcome a user would least expect.
 */
export async function deleteFromCache(
  repoId: string,
  opts: { repoType?: CachedRepo["repoType"]; revision?: string } = {},
): Promise<{ freedBytes: number }> {
  const cacheDir = getSettings().hfCacheDir;
  const repoType = opts.repoType ?? "model";
  const repoPath = path.join(cacheDir, encodeRepoDir(repoId, repoType));

  // Refuse to operate outside the configured cache root.
  const resolvedRepo = path.resolve(repoPath);
  if (!resolvedRepo.startsWith(path.resolve(cacheDir) + path.sep)) {
    throw new Error("Refusing to delete a path outside the cache directory.");
  }
  if (!fs.existsSync(resolvedRepo)) return { freedBytes: 0 };

  const before = (await dirSize(resolvedRepo)).bytes;

  if (!opts.revision) {
    await fsp.rm(resolvedRepo, { recursive: true, force: true });
    return { freedBytes: before };
  }

  const snapPath = path.join(resolvedRepo, "snapshots", opts.revision);
  if (!path.resolve(snapPath).startsWith(resolvedRepo + path.sep)) {
    throw new Error("Invalid revision.");
  }
  await fsp.rm(snapPath, { recursive: true, force: true });

  // Drop refs that pointed at the revision we just removed.
  const refsDir = path.join(resolvedRepo, "refs");
  try {
    for (const ref of await fsp.readdir(refsDir)) {
      const p = path.join(refsDir, ref);
      if ((await fsp.readFile(p, "utf8")).trim() === opts.revision) await fsp.rm(p);
    }
  } catch {
    /* no refs to clean */
  }

  await gcBlobs(resolvedRepo);

  const after = (await dirSize(resolvedRepo)).bytes;
  return { freedBytes: Math.max(0, before - after) };
}

/** Removes blobs no surviving snapshot references. */
async function gcBlobs(repoPath: string): Promise<void> {
  const blobsDir = path.join(repoPath, "blobs");
  const snapshotsDir = path.join(repoPath, "snapshots");

  const referenced = new Set<string>();
  const walk = async (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          referenced.add(await fsp.realpath(p));
        } catch {
          /* dangling link */
        }
      }
    }
  };
  await walk(snapshotsDir);

  try {
    for (const name of await fsp.readdir(blobsDir)) {
      const p = path.join(blobsDir, name);
      if (!referenced.has(await fsp.realpath(p).catch(() => p))) {
        await fsp.rm(p, { force: true });
      }
    }
  } catch {
    /* nothing to collect */
  }
}

/* -------------------------------------------------------------------------- */
/* model config                                                                */
/* -------------------------------------------------------------------------- */

interface RawConfig {
  architectures?: string[];
  model_type?: string;
  num_hidden_layers?: number;
  num_layers?: number;
  n_layer?: number;
  hidden_size?: number;
  n_embd?: number;
  d_model?: number;
  num_attention_heads?: number;
  n_head?: number;
  num_key_value_heads?: number;
  num_kv_heads?: number;
  head_dim?: number;
  vocab_size?: number;
  max_position_embeddings?: number;
  torch_dtype?: string;
  dtype?: string;
  sliding_window?: number | null;
  quantization_config?: { quant_method?: string; bits?: number };
  text_config?: RawConfig;
}

/** Normalises the many spellings HF configs use for the same shape. */
export function parseModelConfig(raw: RawConfig): ModelArchInfo {
  // Multimodal models nest the language model's shape under `text_config`;
  // that inner block is what determines KV cache size.
  const cfg: RawConfig = raw.text_config ? { ...raw, ...raw.text_config } : raw;

  const layers = cfg.num_hidden_layers ?? cfg.num_layers ?? cfg.n_layer ?? null;
  const hidden = cfg.hidden_size ?? cfg.n_embd ?? cfg.d_model ?? null;
  const heads = cfg.num_attention_heads ?? cfg.n_head ?? null;
  const kvHeads = cfg.num_key_value_heads ?? cfg.num_kv_heads ?? heads;
  const headDim = cfg.head_dim ?? (hidden && heads ? Math.round(hidden / heads) : null);

  return {
    architectures: cfg.architectures ?? [],
    modelType: cfg.model_type ?? null,
    numParams: null,
    weightBytes: null,
    numHiddenLayers: layers,
    hiddenSize: hidden,
    numAttentionHeads: heads,
    numKeyValueHeads: kvHeads,
    headDim,
    vocabSize: cfg.vocab_size ?? null,
    maxPositionEmbeddings: cfg.max_position_embeddings ?? null,
    torchDtype: cfg.torch_dtype ?? cfg.dtype ?? null,
    quantization: cfg.quantization_config?.quant_method ?? null,
    slidingWindow: cfg.sliding_window ?? null,
  };
}

/** Reads `config.json` from the newest cached revision of a model. */
export async function readCachedConfig(repoId: string): Promise<ModelArchInfo | null> {
  const repo = await findCachedRepo(repoId, "model");
  if (!repo || repo.revisions.length === 0) return null;
  for (const rev of repo.revisions) {
    try {
      const raw = JSON.parse(
        await fsp.readFile(path.join(rev.snapshotPath, "config.json"), "utf8"),
      );
      const arch = parseModelConfig(raw);
      const measured = await measureWeights(rev.snapshotPath);
      arch.weightBytes = measured;
      arch.numParams = await countParams(rev.snapshotPath, arch, measured);
      return arch;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Total bytes of weight files, from the safetensors index when present and
 * otherwise by measuring the files.
 *
 * This is the figure the VRAM estimate actually wants. Deriving weight size
 * from a parameter count means guessing the effective bytes-per-weight of the
 * checkpoint's quantization, which is exactly the thing that goes wrong on a
 * format the app has not seen before.
 */
async function measureWeights(snapshotPath: string): Promise<number | null> {
  try {
    const idx = JSON.parse(
      await fsp.readFile(path.join(snapshotPath, "model.safetensors.index.json"), "utf8"),
    ) as { metadata?: { total_size?: number } };
    if (idx.metadata?.total_size) return idx.metadata.total_size;
  } catch {
    /* single-shard model, or a format with no index */
  }

  try {
    const files = await fsp.readdir(snapshotPath);
    const weights = files.filter((f) => /\.(safetensors|bin|gguf)$/.test(f));
    if (weights.length === 0) return null;
    let bytes = 0;
    for (const f of weights) {
      bytes += (await fsp.stat(path.join(snapshotPath, f))).size;
    }
    return bytes > 0 ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * Parameter count, stated if the index says so and otherwise derived from the
 * measured weight size divided by the format's effective width.
 *
 * The division has to be quantization-aware: assuming bf16 for an mxfp4
 * checkpoint under-reports gpt-oss-20b as 6.9B parameters. This figure is only
 * displayed — the VRAM estimate uses the measured bytes directly.
 */
async function countParams(
  snapshotPath: string,
  arch: ModelArchInfo,
  weightBytes: number | null,
): Promise<number | null> {
  try {
    const idx = JSON.parse(
      await fsp.readFile(path.join(snapshotPath, "model.safetensors.index.json"), "utf8"),
    ) as { metadata?: { total_parameters?: number } };
    if (idx.metadata?.total_parameters) return idx.metadata.total_parameters;
  } catch {
    /* fall through */
  }

  if (weightBytes == null) return null;
  const bpw = effectiveBytesPerWeight(arch);
  return bpw > 0 ? Math.round(weightBytes / bpw) : null;
}

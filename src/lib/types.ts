/**
 * Types shared across the server/client boundary. Everything here must be
 * JSON-serialisable — these travel over SSE and RSC payloads.
 */

/* -------------------------------------------------------------------------- */
/* telemetry                                                                   */
/* -------------------------------------------------------------------------- */

export interface GpuSample {
  index: number;
  name: string;
  utilGpu: number; // %
  utilMem: number; // %
  memUsedMiB: number;
  memTotalMiB: number;
  tempC: number;
  powerW: number;
  powerCapW: number;
  clockSmMhz: number;
  fanPct: number;
  pstate: string;
}

export interface HostSample {
  cpuPct: number;
  /** Per-core utilisation, in core order. */
  coresPct: number[];
  ramUsedMiB: number;
  ramTotalMiB: number;
  swapUsedMiB: number;
  swapTotalMiB: number;
  loadAvg: [number, number, number];
  diskUsedGiB: number;
  diskTotalGiB: number;
  uptimeS: number;
}

export interface TelemetrySample {
  ts: number;
  gpus: GpuSample[];
  host: HostSample;
}

/* -------------------------------------------------------------------------- */
/* deployments                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lifecycle of a supervised vLLM process.
 *
 *   starting → loading → healthy → stopping → stopped
 *        ↘ failed          ↘ crashed
 *
 * `starting` covers spawn until the first log line; `loading` is the long tail
 * of weight loading and CUDA graph capture, where /health is still refusing
 * connections. Separating them is what lets the UI say "loading weights" rather
 * than looking hung for ninety seconds.
 */
export type DeploymentStatus =
  | "starting"
  | "loading"
  | "healthy"
  | "stopping"
  | "stopped"
  | "failed"
  | "crashed";

export const TRANSITIONAL_STATUSES: readonly DeploymentStatus[] = [
  "starting",
  "loading",
  "stopping",
];

export interface DeploymentProfile {
  id: number;
  name: string;
  model: string;
  servedName: string | null;
  port: number | null;
  /** Only non-default flags, keyed by the long flag name without `--`. */
  flags: Record<string, string | number | boolean | string[]>;
  notes: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Live view of a supervised process. */
export interface LiveDeployment {
  runId: number;
  deploymentId: number | null;
  name: string;
  model: string;
  servedName: string | null;
  port: number;
  pid: number | null;
  status: DeploymentStatus;
  startedAt: number;
  readyAt: number | null;
  /** Human-readable note about the current phase, taken from vLLM's own logs. */
  phase: string | null;
  error: string | null;
  /** VRAM attributed to this process, from nvidia-smi's compute-apps query. */
  vramMiB: number | null;
  metrics: EngineMetrics | null;
}

/** Derived engine metrics for one deployment at one instant. */
export interface EngineMetrics {
  ts: number;
  genTokS: number;
  promptTokS: number;
  requestsRunning: number;
  requestsWaiting: number;
  kvCachePct: number;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftP99Ms: number | null;
  itlP50Ms: number | null;
  itlP95Ms: number | null;
  prefixHitPct: number | null;
  preemptions: number;
  /** Totals since the server started, useful as an absolute counter display. */
  totalPromptTokens: number;
  totalGenTokens: number;
  totalRequests: number;
}

/* -------------------------------------------------------------------------- */
/* vLLM flag schema                                                            */
/* -------------------------------------------------------------------------- */

export type FlagType = "boolean" | "enum" | "int" | "float" | "string" | "list" | "json";

export interface FlagSpec {
  /** Long name without leading dashes, e.g. `max-model-len`. */
  name: string;
  /** Other accepted spellings, e.g. `-tp` for `tensor-parallel-size`. */
  aliases: string[];
  /** The `ConfigGroup` heading it appeared under in `--help=all`. */
  group: string;
  type: FlagType;
  choices: string[] | null;
  /** Default as printed by argparse, verbatim; `null` when none was shown. */
  default: string | null;
  help: string;
  /** True when argparse advertised a `--no-x` counterpart. */
  negatable: boolean;
  /** True when the flag accepts multiple values (`X [X ...]`). */
  variadic: boolean;
  /** Surfaced in the "Essentials" tier above the full group list. */
  essential: boolean;
}

export interface FlagSchema {
  vllmVersion: string;
  generatedAt: number;
  groups: string[];
  flags: FlagSpec[];
}

/* -------------------------------------------------------------------------- */
/* models                                                                      */
/* -------------------------------------------------------------------------- */

export interface CachedRevision {
  hash: string;
  refs: string[];
  /** Bytes unique to this revision plus its share of blobs, see hf/cache.ts. */
  sizeBytes: number;
  lastModified: number;
  snapshotPath: string;
}

export interface CachedRepo {
  repoId: string;
  repoType: "model" | "dataset" | "space";
  /** True on-disk size, counting each blob once. */
  sizeBytes: number;
  revisions: CachedRevision[];
  lastAccessed: number;
  path: string;
}

export interface ModelArchInfo {
  architectures: string[];
  modelType: string | null;
  numParams: number | null;
  /**
   * Total bytes of weight files, when they can be measured rather than
   * inferred. Preferred over `numParams × bytes-per-weight`, which requires
   * guessing the effective width of whatever quantization was used.
   */
  weightBytes: number | null;
  numHiddenLayers: number | null;
  hiddenSize: number | null;
  numAttentionHeads: number | null;
  numKeyValueHeads: number | null;
  headDim: number | null;
  vocabSize: number | null;
  maxPositionEmbeddings: number | null;
  torchDtype: string | null;
  quantization: string | null;
  slidingWindow: number | null;
}

export interface VramEstimate {
  weightsGiB: number;
  kvPerTokenKiB: number;
  kvAtContextGiB: number;
  activationOverheadGiB: number;
  totalGiB: number;
  /** VRAM the app believes is free right now, in GiB. */
  availableGiB: number;
  /**
   * False when `config.json` did not give enough shape to size the model. An
   * unknown estimate is never reported as fitting — the guard rail must fail
   * closed, or it would wave through exactly the launches it exists to catch.
   */
  known: boolean;
  fits: boolean;
  /** Longest context length that fits, given the same settings. */
  maxContextThatFits: number | null;
  notes: string[];
}

export interface HubSearchResult {
  repoId: string;
  author: string | null;
  downloads: number;
  likes: number;
  lastModified: string | null;
  tags: string[];
  pipelineTag: string | null;
  gated: boolean | string;
  /** Detected from tags/filenames: awq, gptq, fp8, gguf, bnb, or null. */
  quantization: string | null;
  cached: boolean;
}

export interface DownloadJob {
  id: number;
  repo: string;
  revision: string;
  status: "running" | "completed" | "failed" | "cancelled";
  pct: number;
  bytesDone: number;
  bytesTotal: number | null;
  message: string | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/* -------------------------------------------------------------------------- */
/* benchmarks                                                                  */
/* -------------------------------------------------------------------------- */

export type BenchmarkStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type ProfileKind =
  | "synchronous"
  | "concurrent"
  | "throughput"
  | "constant"
  | "poisson"
  | "sweep";

export type DataKind = "synthetic_text" | "huggingface" | "json_file" | "csv_file";

export interface BenchmarkConfig {
  name: string;
  /** Which live deployment to point at; the target URL is derived from it. */
  deploymentRunId: number | null;
  target: string;
  model: string | null;
  profile: {
    kind: ProfileKind;
    /** concurrent */ streams?: number;
    /** throughput */ maxConcurrency?: number;
    /** constant | poisson */ rate?: number;
    /** sweep */ sweepSize?: number;
    rampupDuration?: number;
  };
  data: {
    kind: DataKind;
    promptTokens?: number;
    outputTokens?: number;
    /** huggingface | json_file | csv_file */
    source?: string;
  };
  constraints: {
    maxSeconds?: number;
    maxRequests?: number;
    maxErrors?: number;
    maxErrorRate?: number;
  };
  tokenizer: string | null;
  seed: number | null;
}

export interface BenchmarkRun {
  id: number;
  name: string | null;
  deploymentRunId: number | null;
  model: string | null;
  target: string;
  config: BenchmarkConfig;
  argv: string[];
  status: BenchmarkStatus;
  progress: number;
  startedAt: number;
  finishedAt: number | null;
  exitCode: number | null;
  error: string | null;
}

export interface BenchmarkResultRow {
  id: number;
  runId: number;
  idx: number;
  strategy: string | null;
  rate: number | null;
  concurrency: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  requestsOk: number | null;
  requestsErr: number | null;
  reqPerS: number | null;
  outputTokS: number | null;
  totalTokS: number | null;
  ttftMeanMs: number | null;
  ttftP50Ms: number | null;
  ttftP95Ms: number | null;
  ttftP99Ms: number | null;
  itlMeanMs: number | null;
  itlP50Ms: number | null;
  itlP95Ms: number | null;
  itlP99Ms: number | null;
  e2eMeanMs: number | null;
  e2eP50Ms: number | null;
  e2eP95Ms: number | null;
  e2eP99Ms: number | null;
  promptTokMean: number | null;
  outputTokMean: number | null;
}

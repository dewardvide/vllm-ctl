import os from "node:os";
import path from "node:path";

/**
 * Every filesystem location the app touches, resolved once.
 *
 * All app-owned state lives under a single data directory so the whole install
 * can be backed up or wiped with one `rm -rf`. Nothing is ever written into the
 * user's vLLM virtualenv or into the Hugging Face cache except through the
 * official `hf` CLI.
 */

const HOME = os.homedir();

export const DATA_DIR =
  process.env.VLLM_ADMIN_DATA_DIR ?? path.join(HOME, ".vllm-admin");

export const PATHS = {
  home: HOME,
  dataDir: DATA_DIR,
  db: path.join(DATA_DIR, "vllm-admin.db"),
  /** Parsed `vllm serve --help=all` schemas, keyed by vLLM version. */
  schemaCache: path.join(DATA_DIR, "schema-cache"),
  /** One directory per benchmark run, holding GuideLLM's raw output. */
  benchmarks: path.join(DATA_DIR, "benchmarks"),
  /** Captured stdout/stderr per deployment run, for post-mortem on a crash. */
  logs: path.join(DATA_DIR, "logs"),
  /** Records live PIDs so orphans from a hard app crash can be reaped on boot. */
  pidFile: path.join(DATA_DIR, "supervised.json"),
  settings: path.join(DATA_DIR, "settings.json"),
} as const;

/** Default Hugging Face cache, honouring the standard env overrides. */
export function defaultHfCacheDir(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return path.join(process.env.HF_HOME, "hub");
  return path.join(HOME, ".cache", "huggingface", "hub");
}

/** Where the `hf` CLI stores the login token, if the user ran `hf auth login`. */
export function hfTokenFile(): string {
  if (process.env.HF_TOKEN_PATH) return process.env.HF_TOKEN_PATH;
  const hfHome = process.env.HF_HOME ?? path.join(HOME, ".cache", "huggingface");
  return path.join(hfHome, "token");
}
